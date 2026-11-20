"""Scenario templates: a support conversation where the right action flips mid-session."""
from __future__ import annotations

import random
from dataclasses import dataclass, field

from .world import Event, World

NOISE_LEVELS = {"low": 5, "mid": 40, "high": 150}  # events per gap between customer turns
N_CUSTOMERS = 60

ACTIONS = ["issue_refund", "inform_already_reversed", "reship_order", "share_tracking",
           "activate_upgrade", "send_payment_link", "escalate_fraud", "unlock_account",
           "initiate_return", "cancel_order", "pay_invoice", "hold_invoice", "send_reminder",
           "merge_pr", "report_ci_failure", "notify_ci_delayed", "reorder_stock",
           "no_reorder_needed", "escalate_to_human"]

SUPPORT_TEMPLATES = ["double_charge", "order_status", "upgrade_blocked", "account_locked",
                     "cancel_order"]
# Background agent waiting on an external event (modeled on documented cases such as an
# agent watching for a mail reply, claude-code #106696).
BACKGROUND_TEMPLATES = ["awaiting_reply", "ci_result", "stock_threshold"]

INVOICE_POLICY = """- If the vendor replied on the watched email thread approving the invoice -> pay_invoice.
- If the vendor replied on the watched thread disputing the invoice -> hold_invoice.
- If there is no reply on the watched thread by the deadline -> send_reminder."""

CI_POLICY = """- If the CI run for the watched pull request completed with status "passed" -> merge_pr.
- If it completed with status "failed" -> report_ci_failure.
- If there is no completed CI run for the watched pull request by the deadline -> notify_ci_delayed."""

STOCK_THRESHOLD = 15
STOCK_POLICY = f"""- If the on-hand quantity of the watched SKU drops below {STOCK_THRESHOLD} -> reorder_stock (act immediately).
- If at the deadline it is still {STOCK_THRESHOLD} or above -> no_reorder_needed."""
TEMPLATES = SUPPORT_TEMPLATES + BACKGROUND_TEMPLATES


@dataclass
class Scenario:
    template: str
    variant: str  # "critical" (state flips mid-session) or "control" (it doesn't)
    seed: int
    noise: str
    world: World
    target: str
    script: list[str]
    expected_action: str
    default_action: str  # correct action if the agent only knows the initial state
    critical_gap: int  # gap index (0-based, gap g happens before turn g+2)
    distractor_gap: int
    _critical_factory: object = None
    _distractor_factory: object = None
    family: str = "support"  # "support" (live chat) or "background" (scheduler ticks)
    watch: set = field(default_factory=set)  # entities the session subscribes to
    task: str = ""  # background task description shown to the agent
    policy: str = ""  # background policy text (system prompt)
    # gap -> event factories emitted in BOTH variants (e.g. small stock decrements)
    scheduled: dict = field(default_factory=dict)
    # gap -> event factories emitted only in the critical variant (beyond the single critical)
    scheduled_critical: dict = field(default_factory=dict)
    target_noise: object = None  # domain-specific unrelated event for the target account
    log: list = field(default_factory=list)

    @property
    def scenario_id(self) -> str:
        t = f".t{len(self.script)}" if len(self.script) != 4 else ""
        return f"{self.template}.{self.variant}.s{self.seed}.{self.noise}{t}"

    @property
    def speaker(self) -> str:
        return "Customer" if self.family == "support" else "Scheduler"

    @property
    def nudge(self) -> str:
        return ("Yes, please just do it now." if self.family == "support"
                else "Final reminder: call resolve with your final action now.")

    def is_premature(self, turn: int | None) -> bool:
        if turn is None:
            return False
        last = len(self.script) - 1
        if self.family == "support" or self.variant == "control":
            return turn < last
        return turn <= self.critical_gap  # acted before the reply was delivered

    def advance(self, gap: int) -> list[Event]:
        """Generate and apply the events that happen between customer turns."""
        w, r = self.world, self.world.rng
        n = NOISE_LEVELS[self.noise]
        specials: list = list(self.scheduled.get(gap, []))
        if self.variant == "critical":
            specials += self.scheduled_critical.get(gap, [])
        if gap == self.distractor_gap:
            specials.append(self._distractor_factory)
        if self.variant == "critical" and gap == self.critical_gap and self._critical_factory:
            specials.append(self._critical_factory)
        # Specials keep their relative order (it matters for cumulative changes).
        slots = sorted(r.sample(range(n + len(specials)), len(specials)))
        others = [c for c in w.customers if c != self.target]
        events: list[Event] = []
        si = 0
        for i in range(n + len(specials)):
            if si < len(specials) and i == slots[si]:
                ev = specials[si]()
                si += 1
            else:
                x = r.random()
                if x < 0.15:
                    ev = w.low_signal_event(self.target)
                elif x < 0.20:
                    ev = (self.target_noise()
                          if self.target_noise and r.random() < 0.5
                          else w.state_noise_event(self.target))
                elif x < 0.80:
                    ev = w.low_signal_event(r.choice(others))
                else:
                    ev = w.state_noise_event(r.choice(others))
            w.apply(ev)
            events.append(ev)
        self.log.extend(events)
        return events


def _pick_other(w: World, target: str) -> str:
    return w.rng.choice([c for c in w.customers if c != target])


def build(template: str, variant: str, seed: int, noise: str, ticks: int = 4) -> Scenario:
    r = random.Random(f"{template}|{variant}|{seed}|{noise}")
    w = World(rng=r)
    ids = w.add_customers(N_CUSTOMERS)
    target = ids[0]
    c = w.customers[target]
    first = c["name"].split()[0]
    # Long sessions (ticks > 4) apply to background templates only.
    long = template in BACKGROUND_TEMPLATES and ticks > 4
    n_gaps = ticks - 1 if long else 3
    if long:
        critical_gap = r.randint(n_gaps // 3, n_gaps - 1)
        distractor_gap = r.randrange(n_gaps)
    else:
        critical_gap = r.choice([1, 2])  # before turn 3 or turn 4
        distractor_gap = r.choice([0, 1, 2])

    if template == "double_charge":
        order = c["orders"][0]
        order["status"] = "delivered"
        p1 = c["payments"][0]
        dup = {"payment_id": w.new_id("pay"), "amount": p1["amount"], "order_id": order["order_id"],
               "status": "succeeded", "created_at": p1["created_at"]}
        c["payments"].append(dup)
        w.protected |= {p1["payment_id"], dup["payment_id"], order["order_id"]}
        other = _pick_other(w, target)
        op = w.customers[other]["payments"][0]
        crit = lambda: w.make_event(target, "charge.reversed", dup["payment_id"],
                                    {"from": "succeeded", "to": "reversed",
                                     "reason": "duplicate_charge_auto_reversal"}, is_critical=True)
        dist = lambda: w.make_event(other, "charge.reversed", op["payment_id"],
                                    {"from": "succeeded", "to": "reversed",
                                     "reason": "duplicate_charge_auto_reversal"}, is_distractor=True)
        script = [
            f"Hi, this is {first}. I was charged twice for my last order. Can you help?",
            f"It's order {order['order_id']}. I can see two charges of ${order['amount']} on my card.",
            "Okay. Before you do anything, can you double-check everything on your side?",
            "Alright, please go ahead and take care of it now.",
        ]
        expected = {"critical": "inform_already_reversed", "control": "issue_refund"}
        default = "issue_refund"

    elif template == "order_status":
        order = c["orders"][0]
        order["status"] = "in_transit"
        w.protected.add(order["order_id"])
        other = _pick_other(w, target)
        oo = w.customers[other]["orders"][0]
        oo["status"] = "in_transit"
        w.protected.add(oo["order_id"])
        crit = lambda: w.make_event(target, "order.status_changed", order["order_id"],
                                    {"from": "in_transit", "to": "lost",
                                     "carrier_note": "package missing at sort facility"},
                                    is_critical=True)
        dist = lambda: w.make_event(other, "order.status_changed", oo["order_id"],
                                    {"from": "in_transit", "to": "lost",
                                     "carrier_note": "package missing at sort facility"},
                                    is_distractor=True)
        script = [
            f"Hey, {first} here. Where is my order? It's taking forever.",
            f"The order number is {order['order_id']}, the {order['item']}.",
            "Hmm. Can you check once more what's going on with it right now?",
            "Okay, please do whatever is needed to sort this out.",
        ]
        expected = {"critical": "reship_order", "control": "share_tracking"}
        default = "share_tracking"

    elif template == "upgrade_blocked":
        c["plan"] = "basic"
        pay = {"payment_id": w.new_id("pay"), "amount": 9.99, "order_id": None,
               "purpose": "plan_upgrade_to_plus", "status": "failed",
               "created_at": "2026-11-20T09:55:00Z"}
        c["payments"].append(pay)
        w.protected.add(pay["payment_id"])
        other = _pick_other(w, target)
        opay = dict(pay, payment_id=w.new_id("pay"))
        w.customers[other]["payments"].append(opay)
        crit = lambda: w.make_event(target, "payment.status_changed", pay["payment_id"],
                                    {"from": "failed", "to": "succeeded",
                                     "reason": "automatic_retry"}, is_critical=True)
        dist = lambda: w.make_event(other, "payment.status_changed", opay["payment_id"],
                                    {"from": "failed", "to": "succeeded",
                                     "reason": "automatic_retry"}, is_distractor=True)
        script = [
            f"Hi, I'm {first}. I'm trying to upgrade to Plus but it keeps failing.",
            "I tried paying a few minutes ago, it said the payment didn't go through.",
            "Can you look at what's happening with my payment right now?",
            "Okay, please just get my upgrade sorted.",
        ]
        expected = {"critical": "activate_upgrade", "control": "send_payment_link"}
        default = "send_payment_link"

    elif template == "account_locked":
        c["account"] = {"locked": True, "lock_reason": "too_many_failed_logins",
                        "fraud_flag": False}
        other = _pick_other(w, target)
        crit = lambda: w.make_event(target, "account.fraud_flagged", target,
                                    {"signal": "card_testing_from_new_country",
                                     "risk_score": 0.94}, is_critical=True)
        dist = lambda: w.make_event(other, "account.fraud_flagged", other,
                                    {"signal": "card_testing_from_new_country",
                                     "risk_score": 0.94}, is_distractor=True)
        script = [
            f"Hello, {first} here. My account is locked and I can't log in.",
            "I think I typed my password wrong a few times this morning.",
            "Can you verify everything is fine with my account before unlocking it?",
            "Great, please go ahead and fix my account now.",
        ]
        expected = {"critical": "escalate_fraud", "control": "unlock_account"}
        default = "unlock_account"

    elif template == "cancel_order":
        order = c["orders"][0]
        order["status"] = "processing"
        w.protected.add(order["order_id"])
        other = _pick_other(w, target)
        oo = w.customers[other]["orders"][0]
        oo["status"] = "processing"
        w.protected.add(oo["order_id"])
        crit = lambda: w.make_event(target, "order.status_changed", order["order_id"],
                                    {"from": "processing", "to": "shipped",
                                     "carrier": order["carrier"]}, is_critical=True)
        dist = lambda: w.make_event(other, "order.status_changed", oo["order_id"],
                                    {"from": "processing", "to": "shipped",
                                     "carrier": oo["carrier"]}, is_distractor=True)
        script = [
            f"Hi, it's {first}. I want to cancel an order I just placed.",
            f"It's order {order['order_id']}, the {order['item']}. I changed my mind.",
            "Before you cancel, can you check its current status?",
            "Okay, please go ahead.",
        ]
        expected = {"critical": "initiate_return", "control": "cancel_order"}
        default = "cancel_order"

    elif template == "awaiting_reply":
        family = "background"
        inv = f"INV-{r.randint(10000, 99999)}"
        thread = f"thr_{r.randint(10000, 99999)}"
        watch = {thread}
        other = _pick_other(w, target)
        oinv, othread = f"INV-{r.randint(10000, 99999)}", f"thr_{r.randint(10000, 99999)}"
        verdict = r.choice(["approve", "dispute"])
        bodies = {
            "approve": f"Hi, we reviewed {inv} and the amounts are correct. Please proceed with payment.",
            "dispute": f"Hi, we dispute line 3 of {inv}; the quantity is wrong. Please hold payment.",
        }
        crit = lambda: w.make_event(target, "email.received", thread,
                                    {"from": f"billing@{target}.vendor.example",
                                     "subject": f"Re: {inv}", "body": bodies[verdict]},
                                    is_critical=True)
        dist = lambda: w.make_event(other, "email.received", othread,
                                    {"from": f"billing@{other}.vendor.example",
                                     "subject": f"Re: {oinv}",
                                     "body": f"Hi, we dispute line 2 of {oinv}. Please hold payment."},
                                    is_distractor=True)
        task = (f"Vendor account {target} ({c['name']}) was asked to confirm invoice {inv}. "
                f"Watch email thread {thread} for their reply.")
        script = _bg_script(task, ticks if long else 4)
        expected = {"critical": "pay_invoice" if verdict == "approve" else "hold_invoice",
                    "control": "send_reminder"}
        default = "send_reminder"
        policy, target_noise = INVOICE_POLICY, (lambda: w.email_noise_event(target))

    elif template == "ci_result":
        # Coding/background agent waiting on a CI run (cf. LangGraph #9046 / Open SWE).
        family = "background"
        pr = f"pr_{r.randint(100, 999)}"
        watch = {pr}
        other = _pick_other(w, target)
        result = r.choice(["passed", "failed"])
        def ci_event(cid, pr_id, status, **flags):
            return w.make_event(cid, "ci.run_completed", pr_id,
                                {"pipeline": "main-ci", "from": "running", "to": status,
                                 "duration_s": r.randint(200, 900)}, **flags)
        crit = lambda: ci_event(target, pr, result, is_critical=True)
        dist = lambda: ci_event(other, pr, "failed" if result == "passed" else "passed",
                                is_distractor=True)  # same PR number, different repo
        task = (f"Repository account {target} ({c['name']}): pull request {pr} is waiting for "
                f"CI. Watch for the CI run result of {pr}.")
        script = _bg_script(task, ticks if long else 4)
        expected = {"critical": "merge_pr" if result == "passed" else "report_ci_failure",
                    "control": "notify_ci_delayed"}
        default = "notify_ci_delayed"
        policy, target_noise = CI_POLICY, (lambda: w.ci_noise_event(target, exclude=pr))

    elif template == "stock_threshold":
        # Cumulative change: no single event is decisive; many small decrements are.
        family = "background"
        sku = f"SKU-{r.randint(1000, 9999)}"
        watch = {sku}
        start = 40
        c["inventory"] = {sku: start, **{f"SKU-{r.randint(1000, 9999)}": r.randint(20, 200)
                                          for _ in range(6)}}
        other = _pick_other(w, target)
        w.customers[other]["inventory"] = {sku: 30}
        # Decrements per gap: critical crosses below the threshold at critical_gap,
        # control drops by the same number of events but stays above it.
        n_parts = 8 if long else (critical_gap + 1) * 2
        if variant == "critical":
            # stay at >= threshold until the very last decrement, which crosses below it
            steps = _split(r, 20, n_parts - 1) + [start - 20 - STOCK_THRESHOLD + r.randint(1, 6)]
        else:
            steps = _split(r, start - STOCK_THRESHOLD - r.randint(3, 8), n_parts)
        level = {"qty": start}

        def dec(amount, last=False):
            def f():
                frm = level["qty"]
                level["qty"] -= amount
                return w.make_event(target, "inventory.adjusted", sku,
                                    {"from": frm, "to": level["qty"], "delta": -amount,
                                     "reason": "orders_shipped"},
                                    is_critical=last and variant == "critical")
            return f
        scheduled = {}
        if long:  # spread decrements over gaps up to critical_gap; the last one at critical_gap
            gaps = sorted(r.randint(0, critical_gap - 1) for _ in steps[:-1]) + [critical_gap]
        else:
            gaps = [i // 2 for i in range(len(steps))]
        for i, (amt, g) in enumerate(zip(steps, gaps)):
            scheduled.setdefault(g, []).append(dec(amt, last=(i == len(steps) - 1)))
        dist = lambda: w.make_event(other, "inventory.adjusted", sku,
                                    {"from": 30, "to": 4, "delta": -26, "reason": "orders_shipped"},
                                    is_distractor=True)
        crit = None
        task = (f"Store account {target} ({c['name']}): monitor on-hand stock of {sku} "
                f"(currently {start}). Reorder threshold is {STOCK_THRESHOLD}.")
        script = _bg_script(task, ticks if long else 4)
        expected = {"critical": "reorder_stock", "control": "no_reorder_needed"}
        default = "no_reorder_needed"
        policy, target_noise = STOCK_POLICY, (lambda: w.inventory_noise_event(target, exclude=sku))
    else:
        raise ValueError(template)

    # Every action the scenario can expect must be selectable in the resolve tool.
    assert set(expected.values()) | {default} <= set(ACTIONS), (template, expected)
    sc = Scenario(template=template, variant=variant, seed=seed, noise=noise, world=w,
                  target=target, script=script, expected_action=expected[variant],
                  default_action=default, critical_gap=critical_gap,
                  distractor_gap=distractor_gap, _critical_factory=crit,
                  _distractor_factory=dist)
    if template in BACKGROUND_TEMPLATES:
        sc.family, sc.watch, sc.task = family, watch, task
        sc.policy, sc.target_noise = policy, target_noise
        if template == "stock_threshold":
            sc.scheduled = scheduled
    return sc


def _bg_script(task: str, ticks: int) -> list[str]:
    lines = [f"Task started. {task} Reply 'waiting' if there is nothing to do yet."]
    for i in range(1, ticks - 1):
        m = 15 * i
        lines.append(f"Tick {10 + m // 60}:{m % 60:02d}. Continue your task.")
    m = 15 * (ticks - 1)
    lines.append(f"Deadline reached ({10 + m // 60}:{m % 60:02d}). Take your final action now.")
    return lines


def _split(r: random.Random, total: int, parts: int) -> list[int]:
    """Split total into `parts` positive integers."""
    cuts = sorted(r.sample(range(1, total), parts - 1))
    return [b - a for a, b in zip([0] + cuts, cuts + [total])]
