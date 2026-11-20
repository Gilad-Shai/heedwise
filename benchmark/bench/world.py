"""Simulated operational world: customers, their state, and a stream of events.

Everything is deterministic given a seed, so every strategy sees the exact same
world and the exact same event stream for a given scenario.
"""
from __future__ import annotations

import copy
import json
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

BASE_TIME = datetime(2026, 11, 20, 10, 0, 0, tzinfo=timezone.utc)

FIRST_NAMES = ["Dana", "Noa", "Avi", "Maya", "Yoni", "Tal", "Lior", "Shira", "Omer", "Gal",
               "Ron", "Yael", "Eden", "Ido", "Roni", "Amit", "Nir", "Hila", "Itay", "Keren"]
LAST_NAMES = ["Cohen", "Levi", "Mizrahi", "Peretz", "Biton", "Friedman", "Azulay", "Katz",
              "Shapiro", "Ben-David", "Golan", "Avraham", "Dahan", "Ohana", "Segal"]
PRODUCTS = ["wireless headphones", "running shoes", "coffee grinder", "desk lamp", "yoga mat",
            "backpack", "smart watch", "blender", "keyboard", "water bottle"]
CARRIERS = ["UPS", "FedEx", "DHL"]

# Event types that do not change any business-relevant state ("telemetry").
LOW_SIGNAL_TYPES = ["page_view", "email_opened", "session_started", "search_performed",
                    "support_article_viewed", "cart_updated"]


def ts(seconds: int) -> str:
    return (BASE_TIME + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class Event:
    event_id: str
    ts: str
    customer_id: str
    type: str
    entity_id: str
    data: dict
    # Fields below are bookkeeping for scoring; never shown to the agent.
    is_critical: bool = False
    is_distractor: bool = False

    def public(self) -> dict:
        return {"event_id": self.event_id, "ts": self.ts, "customer_id": self.customer_id,
                "type": self.type, "entity_id": self.entity_id, "data": self.data}


@dataclass
class World:
    rng: random.Random
    customers: dict = field(default_factory=dict)
    clock: int = 0
    _seq: int = 0
    # Entities the scenario depends on; background noise never touches them.
    protected: set = field(default_factory=set)

    # ---------- construction ----------
    def new_id(self, prefix: str) -> str:
        self._seq += 1
        return f"{prefix}_{self.rng.randint(100, 999)}{self._seq:04d}"

    def make_customer(self, cid: str) -> dict:
        r = self.rng
        name = f"{r.choice(FIRST_NAMES)} {r.choice(LAST_NAMES)}"
        n_orders = r.randint(1, 3)
        orders = []
        for _ in range(n_orders):
            orders.append({
                "order_id": self.new_id("ord"),
                "item": r.choice(PRODUCTS),
                "amount": round(r.uniform(20, 300), 2),
                "status": r.choice(["delivered", "delivered", "in_transit", "processing"]),
                "carrier": r.choice(CARRIERS),
                "tracking": f"TRK{r.randint(10**8, 10**9 - 1)}",
            })
        payments = [{
            "payment_id": self.new_id("pay"),
            "amount": o["amount"],
            "order_id": o["order_id"],
            "status": "succeeded",
            "created_at": ts(-r.randint(3600, 86400 * 20)),
        } for o in orders]
        return {
            "customer_id": cid,
            "name": name,
            "email": f"{name.split()[0].lower()}.{cid[-4:]}@example.com",
            "plan": r.choice(["basic", "basic", "plus"]),
            "account": {"locked": False, "lock_reason": None, "fraud_flag": False},
            "profile": {"marketing_opt_in": r.choice([True, False]),
                        "shipping_city": r.choice(["Tel Aviv", "Haifa", "Jerusalem", "Beersheba"])},
            "orders": orders,
            "payments": payments,
            "inbox": [],
            "ci_runs": [],
            "inventory": {},
            "activity_log": [],
        }

    def add_customers(self, n: int) -> list[str]:
        ids = []
        for _ in range(n):
            cid = self.new_id("cus")
            self.customers[cid] = self.make_customer(cid)
            ids.append(cid)
        return ids

    # ---------- events ----------
    def make_event(self, cid: str, etype: str, entity_id: str, data: dict, **flags) -> Event:
        self.clock += self.rng.randint(1, 6)
        return Event(self.new_id("evt"), ts(self.clock), cid, etype, entity_id, data, **flags)

    def apply(self, ev: Event) -> None:
        """Mutate world state according to the event, and append to the activity log."""
        c = self.customers[ev.customer_id]
        d = ev.data
        if ev.type == "order.status_changed":
            for o in c["orders"]:
                if o["order_id"] == ev.entity_id:
                    o["status"] = d["to"]
        elif ev.type in ("payment.status_changed", "charge.reversed"):
            for p in c["payments"]:
                if p["payment_id"] == ev.entity_id:
                    p["status"] = d["to"]
        elif ev.type == "account.fraud_flagged":
            c["account"]["fraud_flag"] = True
        elif ev.type == "profile.updated":
            c["profile"][d["field"]] = d["to"]
        elif ev.type == "email.received":
            c["inbox"].append({"ts": ev.ts, "thread_id": ev.entity_id, **d})
            c["inbox"] = c["inbox"][-100:]
        elif ev.type == "ci.run_completed":
            c["ci_runs"].append({"ts": ev.ts, "pull_request": ev.entity_id,
                                 "pipeline": d["pipeline"], "status": d["to"]})
            c["ci_runs"] = c["ci_runs"][-100:]
        elif ev.type == "inventory.adjusted":
            c["inventory"][ev.entity_id] = d["to"]
        c["activity_log"].append({"ts": ev.ts, "type": ev.type, "entity_id": ev.entity_id,
                                  "data": d})
        c["activity_log"] = c["activity_log"][-40:]

    def low_signal_event(self, cid: str) -> Event:
        r = self.rng
        etype = r.choice(LOW_SIGNAL_TYPES)
        data = {
            "page_view": lambda: {"path": r.choice(["/", "/orders", "/account", "/help",
                                                     f"/product/{r.randint(1, 500)}"])},
            "email_opened": lambda: {"campaign": r.choice(["black_friday", "weekly_digest",
                                                            "restock_alert"])},
            "session_started": lambda: {"device": r.choice(["ios", "android", "web"])},
            "search_performed": lambda: {"query": r.choice(PRODUCTS)},
            "support_article_viewed": lambda: {"article": r.choice(["returns-policy",
                                                                     "shipping-times",
                                                                     "reset-password"])},
            "cart_updated": lambda: {"item": r.choice(PRODUCTS), "qty": r.randint(1, 3)},
        }[etype]()
        return self.make_event(cid, etype, cid, data)

    def state_noise_event(self, cid: str) -> Event:
        """A real state change for a customer that is unrelated to any support issue."""
        r = self.rng
        c = self.customers[cid]
        choice = r.random()
        if choice < 0.4:
            field_name = r.choice(["marketing_opt_in", "shipping_city"])
            old = c["profile"][field_name]
            new = (not old) if field_name == "marketing_opt_in" else r.choice(
                ["Tel Aviv", "Haifa", "Jerusalem", "Beersheba", "Eilat"])
            return self.make_event(cid, "profile.updated", cid,
                                   {"field": field_name, "from": old, "to": new})
        # an order progressing normally
        candidates = [o for o in c["orders"] if o["order_id"] not in self.protected]
        o = r.choice(candidates) if candidates else None
        nxt = {"processing": "in_transit", "in_transit": "delivered"}.get(o["status"]) if o else None
        if nxt is None:
            return self.low_signal_event(cid)
        return self.make_event(cid, "order.status_changed", o["order_id"],
                               {"from": o["status"], "to": nxt})

    def email_noise_event(self, cid: str) -> Event:
        """An unrelated email landing in an account's inbox."""
        r = self.rng
        subject, body = r.choice([
            ("Your weekly statement", "Your statement for this week is attached."),
            ("Price list update", "Please find our updated 2027 price list."),
            ("Holiday shipping schedule", "Our warehouse closes Dec 24-26."),
            ("Re: catalog photos", "Sending the new product photos shortly."),
            ("Out of office", "I am out of the office until Monday."),
        ])
        thread = f"thr_{r.randint(1000, 9999)}"
        return self.make_event(cid, "email.received", thread,
                               {"from": "contact@vendor.example", "subject": subject, "body": body})

    def ci_noise_event(self, cid: str, exclude: str) -> Event:
        """A CI run finishing for some other pull request of the same account."""
        r = self.rng
        pr = exclude
        while pr == exclude:
            pr = f"pr_{r.randint(100, 999)}"
        status = r.choice(["passed", "passed", "failed"])
        return self.make_event(cid, "ci.run_completed", pr,
                               {"pipeline": r.choice(["main-ci", "lint", "e2e"]),
                                "from": "running", "to": status,
                                "duration_s": r.randint(60, 900)})

    def inventory_noise_event(self, cid: str, exclude: str) -> Event:
        """Stock moving on some other SKU of the same account."""
        r = self.rng
        inv = self.customers[cid]["inventory"]
        skus = [s for s in inv if s != exclude]
        if not skus:
            return self.low_signal_event(cid)
        s = r.choice(skus)
        delta = r.choice([-1, -2, -3, -5, 10, 20])
        frm = inv[s]
        return self.make_event(cid, "inventory.adjusted", s,
                               {"from": frm, "to": max(0, frm + delta), "delta": delta,
                                "reason": "orders_shipped" if delta < 0 else "restock_received"})

    def snapshot(self, cid: str) -> str:
        return json.dumps(copy.deepcopy(self.customers[cid]), sort_keys=True, indent=1)
