"""Runs one scenario with one strategy: a manual Messages API loop.

A manual loop (not the SDK tool runner) is needed because the benchmark injects
live updates between customer turns.
"""
from __future__ import annotations

import time

from .scenarios import Scenario
from .strategies import Strategy

# $ per 1M tokens: input, output, cache_read, cache_write(5m)
PRICING = {
    "claude-opus-5-5": (4.00, 20.00, 0.20, 5.00),
    "claude-sonnet-5-5": (2.00, 10.00, 0.10, 2.50),
    "claude-haiku-5-5": (0.10, 0.50, 0.01, 0.125),
    "mock": (4.00, 20.00, 0.20, 5.00),
}
MAX_CALLS_PER_TURN = 6


def _get(block, attr):
    return block.get(attr) if isinstance(block, dict) else getattr(block, attr, None)


def run(client, model: str, effort: str, sc: Scenario, strat: Strategy) -> dict:
    usage = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    calls = tool_calls = 0
    messages: list = []
    resolution = None
    resolved_turn = None
    error = None
    cost = 0.0
    t0 = time.time()
    script = sc.script + [sc.nudge]

    for turn, customer_msg in enumerate(script):
        content = []
        if turn == 0:
            content.append({"type": "text", "text": strat.opening(sc)})
        elif turn < len(sc.script):  # no new events before the nudge turn
            events = sc.advance(turn - 1)
            upd = strat.render_updates(sc, events)
            if upd:
                content.append({"type": "text", "text": upd})
        content.append({"type": "text", "text": f"{sc.speaker}: {customer_msg}"})
        messages.append({"role": "user", "content": content})

        for _ in range(MAX_CALLS_PER_TURN):
            try:
                resp = client.messages.create(
                    model=model,
                    max_tokens=8000,
                    system=strat.system(sc),
                    tools=strat.tools(),
                    messages=messages,
                    cache_control={"type": "ephemeral"},
                    output_config={"effort": effort},
                )
            except Exception as e:  # recorded, scenario counted as failed
                error = f"{type(e).__name__}: {e}"
                break
            calls += 1
            u = resp.usage
            c_in, c_out = u.input_tokens or 0, u.output_tokens or 0
            c_cr = getattr(u, "cache_read_input_tokens", 0) or 0
            c_cw = getattr(u, "cache_creation_input_tokens", 0) or 0
            usage["input"] += c_in
            usage["output"] += c_out
            usage["cache_read"] += c_cr
            usage["cache_write"] += c_cw
            p_in, p_out, p_cr, p_cw = PRICING.get(model, PRICING["claude-opus-5-5"])
            # Haiku 5.5 bills prompts over 100K tokens at 5x the base rates.
            mult = 5 if model == "claude-haiku-5-5" and c_in + c_cr + c_cw > 100_000 else 1
            cost += mult * (c_in * p_in + c_out * p_out + c_cr * p_cr + c_cw * p_cw) / 1e6
            if resp.stop_reason == "refusal":
                error = "refusal"
                break
            messages.append({"role": "assistant", "content": resp.content})
            tool_uses = [b for b in resp.content if _get(b, "type") == "tool_use"]
            if not tool_uses:
                break  # replied to the customer; wait for next customer turn
            results = []
            for b in tool_uses:
                tool_calls += 1
                name, args = _get(b, "name"), _get(b, "input") or {}
                if name == "resolve" and resolution is None:
                    resolution = args
                    resolved_turn = turn
                    out, is_err = "Resolved. Session closed.", False
                else:
                    out, is_err = strat.handle_tool(sc, name, args)
                results.append({"type": "tool_result", "tool_use_id": _get(b, "id"),
                                "content": out, "is_error": is_err})
            if resolution is not None:
                break
            messages.append({"role": "user", "content": results})
        if resolution is not None or error:
            break

    action = (resolution or {}).get("action")
    correct = (action == sc.expected_action
               and (resolution or {}).get("customer_id") == sc.target)
    return {
        "scenario": sc.scenario_id, "template": sc.template, "variant": sc.variant,
        "seed": sc.seed, "noise": sc.noise, "strategy": strat.name, "model": model,
        "effort": effort, "expected": sc.expected_action, "action": action,
        "resolved_customer": (resolution or {}).get("customer_id"),
        "reason": (resolution or {}).get("reason"), "correct": correct,
        "stale": sc.variant == "critical" and action == sc.default_action,
        "wrong_customer": bool(resolution) and resolution.get("customer_id") != sc.target,
        "family": sc.family, "turns": len(sc.script),
        "premature": sc.is_premature(resolved_turn),
        "resolved_turn": resolved_turn, "api_calls": calls, "tool_calls": tool_calls,
        "tokens_in_total": usage["input"] + usage["cache_read"] + usage["cache_write"],
        **{f"tok_{k}": v for k, v in usage.items()},
        "cost_usd": round(cost, 6), "seconds": round(time.time() - t0, 1), "error": error,
    }
