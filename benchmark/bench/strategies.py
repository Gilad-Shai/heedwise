"""The five ways of getting changing data into the agent's context."""
from __future__ import annotations

import json

from .scenarios import ACTIONS, Scenario
from .world import LOW_SIGNAL_TYPES, Event, ts

BASE_SYSTEM = """You are a customer support agent for Acme Store, chatting live with one customer.

Policy (follow exactly, based on the most current information available to you):
- Duplicate charge: if the duplicate payment is still "succeeded" -> issue_refund. If it is already "reversed" -> inform_already_reversed.
- Order whereabouts: if the order status is "lost" -> reship_order. If it is "in_transit" or "delivered" -> share_tracking.
- Plan upgrade blocked: if the latest upgrade payment is "succeeded" -> activate_upgrade. If it is "failed" -> send_payment_link.
- Locked account: if the account has fraud_flag = true -> escalate_fraud (never unlock). Otherwise -> unlock_account.
- Cancel order: if the order is "processing" -> cancel_order. If it is "shipped" -> initiate_return.
- Anything else -> escalate_to_human.

Customer data can change while the conversation is in progress. Always act on the most current information you have.
Talk to the customer briefly. Call the `resolve` tool exactly once, only when the customer asks you to proceed / take care of it. Resolve only for the customer you are chatting with."""

BACKGROUND_SYSTEM = """You are a background finance-operations agent for Acme Store. A scheduler wakes you periodically; there is no human in the conversation.

Policy (follow exactly, based on the most current information available to you):
{policy}
- Anything else -> escalate_to_human.

Account data changes while you wait. Always act on the most current information you have.
Call the `resolve` tool exactly once: as soon as the policy's condition is met, or at the deadline. Until then, reply with one short line and take no action. Act only for the account and the item named in your task; ignore other items and other accounts."""

RESOLVE_TOOL = {
    "name": "resolve",
    "description": "Take the final action for this customer's issue. Ends the support session.",
    "strict": True,
    "input_schema": {
        "type": "object",
        "properties": {
            "customer_id": {"type": "string"},
            "action": {"type": "string", "enum": ACTIONS},
            "reason": {"type": "string", "description": "One sentence, citing the data used."},
        },
        "required": ["customer_id", "action", "reason"],
        "additionalProperties": False,
    },
}

STATE_TOOL = {
    "name": "get_customer_state",
    "description": "Fetch the full, current customer record (orders, payments, account, recent activity log).",
    "strict": True,
    "input_schema": {
        "type": "object",
        "properties": {"customer_id": {"type": "string"}},
        "required": ["customer_id"],
        "additionalProperties": False,
    },
}

PUSH_NOTE = ("\n\nLive updates from the company event system may be attached to customer messages "
             "inside <live_updates> tags. They reflect changes since the previous message.")

SALIENT_TYPES = {"order.status_changed", "payment.status_changed", "charge.reversed",
                 "account.fraud_flagged", "profile.updated", "email.received",
                 "ci.run_completed", "inventory.adjusted"}
HIGH_SEVERITY = {"payment.status_changed", "charge.reversed", "account.fraud_flagged"}


class Strategy:
    name = "base"
    uses_state_tool = False
    pushes = False

    def system(self, sc: Scenario) -> str:
        base = (BASE_SYSTEM if sc.family == "support"
                else BACKGROUND_SYSTEM.format(policy=sc.policy))
        return base + (PUSH_NOTE if self.pushes else "")

    def tools(self) -> list:
        return [STATE_TOOL, RESOLVE_TOOL] if self.uses_state_tool else [RESOLVE_TOOL]

    def opening(self, sc: Scenario) -> str:
        return (f"Session started with account {sc.target}. Account record at session start "
                f"(as_of {ts(0)}):\n<customer_record>\n{sc.world.snapshot(sc.target)}\n</customer_record>")

    def render_updates(self, sc: Scenario, events: list[Event]) -> str | None:
        return None

    def handle_tool(self, sc: Scenario, name: str, args: dict) -> tuple[str, bool]:
        if name == "get_customer_state" and self.uses_state_tool:
            cid = args.get("customer_id", "")
            if cid not in sc.world.customers:
                return f"Error: unknown customer_id {cid!r}", True
            return sc.world.snapshot(cid), False
        return f"Error: tool {name!r} is not available", True


class Static(Strategy):
    """S0: snapshot at session start, nothing after. The 'no real-time' baseline."""
    name = "static"


class Poll(Strategy):
    """S1: the agent may re-fetch the full record whenever it wants."""
    name = "poll"
    uses_state_tool = True

    def system(self, sc: Scenario) -> str:
        return super().system(sc) + ("\n\nUse `get_customer_state` to fetch the latest account "
                                     "record (including inbox) whenever you need current data.")


class Firehose(Strategy):
    """S2: every new event in the company, raw JSON, appended each turn."""
    name = "firehose"
    pushes = True

    def render_updates(self, sc, events):
        lines = "\n".join(json.dumps(e.public(), sort_keys=True) for e in events)
        return f"<live_updates>\n{lines}\n</live_updates>"


class EntityRaw(Strategy):
    """S3: only this customer's events, raw JSON (naive per-entity subscription)."""
    name = "entity_raw"
    pushes = True

    def render_updates(self, sc, events):
        mine = [e for e in events if e.customer_id == sc.target]
        if not mine:
            return "<live_updates>\n(no events)\n</live_updates>"
        lines = "\n".join(json.dumps(e.public(), sort_keys=True) for e in mine)
        return f"<live_updates customer_id=\"{sc.target}\">\n{lines}\n</live_updates>"


class Attention(Strategy):
    """S4: session-scoped, salience-filtered, coalesced state delta (the proposed layer, v0)."""
    name = "attention"
    pushes = True
    max_lines = 8

    def render_updates(self, sc, events):
        mine = [e for e in events if e.customer_id == sc.target and e.type in SALIENT_TYPES]
        as_of = events[-1].ts if events else ts(0)
        # Coalesce: one line per (entity, field), keep first 'from' and last 'to'.
        merged: dict = {}
        for e in mine:
            if e.type == "email.received":
                # Messages are not state diffs: one line per message, HIGH only if the
                # session subscribed to that thread.
                merged[(e.entity_id, e.event_id)] = {
                    "type": e.type, "entity": e.entity_id, "field": "new_message",
                    "from": None, "to": f"\"{e.data['subject']}\": {e.data['body']}",
                    "ts": e.ts, "extra": "", "watched": e.entity_id in sc.watch}
                continue
            fld = {"profile.updated": e.data.get("field"), "account.fraud_flagged": "fraud_flag",
                   "inventory.adjusted": "on_hand", "ci.run_completed": "ci_status"}.get(
                       e.type, "status")
            key = (e.entity_id, fld)
            if key in merged:
                merged[key]["to"] = e.data.get("to", True)
                merged[key]["ts"] = e.ts
                merged[key]["extra"] = _extra(e)
            else:
                merged[key] = {"type": e.type, "entity": e.entity_id, "field": fld,
                               "from": e.data.get("from", False), "to": e.data.get("to", True),
                               "ts": e.ts, "extra": _extra(e),
                               "watched": e.entity_id in sc.watch}
        items = [m for m in merged.values() if m["from"] != m["to"]]
        items.sort(key=lambda m: (0 if _sev(m) == "HIGH" else 1, m["ts"]))
        dropped = max(0, len(items) - self.max_lines)
        items = items[: self.max_lines]
        header = f"<live_updates customer_id=\"{sc.target}\" as_of=\"{as_of}\">"
        if not items:
            return f"{header}\nNo relevant changes since last message.\n</live_updates>"
        lines = [(f"- [{_sev(m)}] {m['entity']} new message: {m['to']} at {m['ts']}"
                  if m["type"] == "email.received" else
                  f"- [{_sev(m)}] {m['entity']} {m['field']}: {m['from']} -> {m['to']}"
                  f"{' (' + m['extra'] + ')' if m['extra'] else ''} at {m['ts']}") for m in items]
        if dropped:
            lines.append(f"- (+{dropped} lower-priority changes omitted)")
        return header + "\n" + "\n".join(lines) + "\n</live_updates>"


def _sev(m: dict) -> str:
    if m.get("watched"):
        return "HIGH"  # the session explicitly subscribed to this entity
    if m["type"] in ("email.received", "ci.run_completed", "inventory.adjusted"):
        return "low"
    if m["type"] in HIGH_SEVERITY:
        return "HIGH"
    if m["type"] == "order.status_changed" and m["to"] in ("lost", "shipped", "returned"):
        return "HIGH"
    return "low"


def _extra(e: Event) -> str:
    d = e.data
    for k in ("reason", "carrier_note", "signal"):
        if k in d:
            return f"{k}={d[k]}"
    return ""


ALL = {s.name: s for s in (Static, Poll, Firehose, EntityRaw, Attention)}
assert set(LOW_SIGNAL_TYPES).isdisjoint(SALIENT_TYPES)
