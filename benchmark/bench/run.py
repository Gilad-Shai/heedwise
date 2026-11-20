"""CLI: run the benchmark grid and write results + a summary table.

Examples:
  uv run python -m bench.run --mock
  uv run python -m bench.run --model claude-opus-5-5 --seeds 1 --noise mid   # pilot
"""
from __future__ import annotations

import argparse
import json
import statistics
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

from . import agent, scenarios, strategies


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="claude-opus-5-5")
    ap.add_argument("--effort", default="medium", choices=["low", "medium", "high", "xhigh", "max"])
    ap.add_argument("--strategies", default=",".join(strategies.ALL))
    ap.add_argument("--templates", default=",".join(scenarios.TEMPLATES))
    ap.add_argument("--variants", default="critical,control")
    ap.add_argument("--noise", default="low,mid,high")
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--ticks", type=int, default=4, help="session length for background templates")
    ap.add_argument("--mock", action="store_true", help="offline plumbing test, no API calls")
    ap.add_argument("--out", default="results")
    a = ap.parse_args()

    if a.mock:
        from .mock import MockClient
        client_factory, model = MockClient, "mock"
    else:
        import anthropic
        shared = anthropic.Anthropic(max_retries=6)
        client_factory, model = (lambda: shared), a.model

    jobs = [(t, v, s, n, st)
            for t in a.templates.split(",") for v in a.variants.split(",")
            for s in range(a.seeds) for n in a.noise.split(",")
            for st in a.strategies.split(",")]
    run_dir = Path(a.out) / f"{datetime.now():%Y%m%d-%H%M%S}-{model}"
    run_dir.mkdir(parents=True, exist_ok=True)
    print(f"{len(jobs)} runs -> {run_dir}")

    def one(job):
        t, v, s, n, st = job
        sc = scenarios.build(t, v, s, n, a.ticks)
        return agent.run(client_factory(), model, a.effort, sc, strategies.ALL[st]())

    rows = []
    with open(run_dir / "runs.jsonl", "w") as f, ThreadPoolExecutor(a.workers) as pool:
        futs = [pool.submit(one, j) for j in jobs]
        for i, fut in enumerate(as_completed(futs), 1):
            r = fut.result()
            rows.append(r)
            f.write(json.dumps(r) + "\n")
            f.flush()
            if i % 10 == 0 or i == len(jobs):
                spent = sum(x["cost_usd"] for x in rows)
                print(f"  {i}/{len(jobs)} done, ${spent:.2f} so far")

    summary = summarize(rows)
    (run_dir / "summary.md").write_text(summary)
    print(summary)


def summarize(rows: list[dict]) -> str:
    def block(group_key) -> list[str]:
        g = defaultdict(list)
        for r in rows:
            g[group_key(r)].append(r)
        out = []
        for k in sorted(g):
            rs = g[k]
            crit = [r for r in rs if r["variant"] == "critical"]
            out.append("| " + " | ".join([
                *k, str(len(rs)),
                f"{100 * sum(r['correct'] for r in rs) / len(rs):.0f}%",
                f"{100 * sum(r['correct'] for r in crit) / max(1, len(crit)):.0f}%",
                f"{100 * sum(r['stale'] for r in crit) / max(1, len(crit)):.0f}%",
                f"{sum(r['wrong_customer'] for r in rs)}",
                f"{statistics.mean(r['tokens_in_total'] for r in rs):,.0f}",
                f"{statistics.mean(r['tok_output'] for r in rs):,.0f}",
                f"${statistics.mean(r['cost_usd'] for r in rs):.4f}",
                f"{statistics.mean(r['api_calls'] for r in rs):.1f}",
                f"{sum(1 for r in rs if r['error'])}",
            ]) + " |")
        return out

    hdr = ("| {keys} | n | accuracy | acc. (critical) | stale | wrong cust. | avg input tok | "
           "avg output tok | avg cost | avg calls | errors |")
    sep = lambda k: "|" + "---|" * (k + 10)
    lines = ["# Results", "", f"runs: {len(rows)}, total cost: ${sum(r['cost_usd'] for r in rows):.2f}",
             "", "## By strategy", "", hdr.format(keys="strategy"), sep(1),
             *block(lambda r: (r["strategy"],)),
             "", "## By strategy x family", "", hdr.format(keys="strategy | family"), sep(2),
             *block(lambda r: (r["strategy"], r["family"])),
             "", "## By strategy x noise", "", hdr.format(keys="strategy | noise"), sep(2),
             *block(lambda r: (r["strategy"], r["noise"])),
             "", "## By strategy x template", "", hdr.format(keys="strategy | template"), sep(2),
             *block(lambda r: (r["strategy"], r["template"]))]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    main()
