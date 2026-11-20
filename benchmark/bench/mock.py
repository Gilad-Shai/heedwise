"""Offline stand-in for the Anthropic client, to test plumbing without spending money.

It is not a meaningful agent: it reads the latest text it has seen and applies the
policy with simple string checks. Token counts are estimated as chars / 4.
"""
from __future__ import annotations

import json
import re
from types import SimpleNamespace


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    out = []
    for b in content:
        t = b.get("type") if isinstance(b, dict) else getattr(b, "type", None)
        if t == "text":
            out.append(b["text"] if isinstance(b, dict) else b.text)
        elif t == "tool_result":
            out.append(str(b["content"]))
    return "\n".join(out)


class _Messages:
    def __init__(self):
        self._n = 0

    def create(self, *, model, system, tools, messages, **_):
        self._n += 1
        prompt = system + json.dumps(tools) + "".join(_text_of(m["content"]) for m in messages
                                                     if m["role"] == "user")
        usage = SimpleNamespace(input_tokens=len(prompt) // 4, output_tokens=40,
                                cache_read_input_tokens=0, cache_creation_input_tokens=0)
        last = _text_of(messages[-1]["content"])
        cid = re.search(r"Session started with account (\S+)\.", _text_of(messages[0]["content"])).group(1)
        names = {t["name"] for t in tools}
        wants_action = any(k in last for k in ("go ahead", "do it now", "take care", "sort",
                                               "fix my account", "Resolved", "Deadline",
                                               "final action"))
        if wants_action and "get_customer_state" in names and "tool_result" not in json.dumps(
                messages[-1]["content"], default=str):
            block = SimpleNamespace(type="tool_use", id=f"tu_{self._n}", name="get_customer_state",
                                    input={"customer_id": cid})
            return SimpleNamespace(content=[block], stop_reason="tool_use", usage=usage)
        if wants_action:
            everything = "\n".join(_text_of(m["content"]) for m in messages if m["role"] == "user")
            action = _guess(everything)
            block = SimpleNamespace(type="tool_use", id=f"tu_{self._n}", name="resolve",
                                    input={"customer_id": cid, "action": action, "reason": "mock"})
            return SimpleNamespace(content=[block], stop_reason="tool_use", usage=usage)
        block = SimpleNamespace(type="text", text="Let me look into that for you.")
        return SimpleNamespace(content=[block], stop_reason="end_turn", usage=usage)


def _guess(text: str) -> str:
    if "Watch email thread" in text:
        thread = re.search(r"Watch email thread (\S+?)\.? for", text).group(1)
        if text.count(thread) > 1:  # mentioned again after the task statement
            return "hold_invoice" if "Please hold payment" in text else "pay_invoice"
        return "send_reminder"
    if "charged twice" in text:
        return "inform_already_reversed" if "reversed" in text else "issue_refund"
    if "Where is my order" in text:
        return "reship_order" if '"lost"' in text or "-> lost" in text else "share_tracking"
    if "upgrade" in text:
        return "activate_upgrade" if "succeeded" in text.split("upgrade")[-1] else "send_payment_link"
    if "locked" in text:
        return "escalate_fraud" if "fraud_flagged" in text or "fraud_flag: False -> True" in text else "unlock_account"
    if "cancel" in text:
        return "initiate_return" if "shipped" in text else "cancel_order"
    return "escalate_to_human"


class MockClient:
    def __init__(self):
        self.messages = _Messages()
