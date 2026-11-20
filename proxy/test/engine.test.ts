// Engine behaviour, using the benchmark's background scenarios as fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AttentionEngine, MemoryStore } from "../src/engine.ts";
import type { SourceEvent } from "../src/types.ts";

let clock = Date.parse("2026-11-20T10:00:00Z");
const now = () => clock;
let n = 0;
const ev = (p: Partial<SourceEvent> & Pick<SourceEvent, "entity" | "type" | "changes">): SourceEvent => ({
  id: `evt_${++n}`, source: "github", account: "octo/repo", ts: new Date(clock + n * 1000).toISOString(), ...p,
});
const fresh = (opts = {}) => new AttentionEngine(new MemoryStore(), { now, ...opts });

test("ci_result: only the watched PR is delivered, distractors are dropped", () => {
  const e = fresh();
  e.watch({ session: "s1", source: "github", account: "octo/repo", entity: "pr/171" });
  // noise: other PRs in the same repo, and the SAME PR number in another repo (distractor)
  for (let i = 0; i < 50; i++) e.ingest(ev({ entity: `pr/${200 + i}`, type: "ci.run_completed", changes: { ci_status: { from: "running", to: "passed" } } }));
  e.ingest(ev({ account: "other/repo", entity: "pr/171", type: "ci.run_completed", changes: { ci_status: { from: "running", to: "passed" } } }));
  const urgent = e.ingest(ev({ entity: "pr/171", type: "ci.run_completed", changes: { ci_status: { from: "running", to: "failed" } } }));
  assert.deepEqual([...urgent], ["s1"]);
  const d = e.drain("s1");
  assert.ok(d);
  assert.equal(d.lines.length, 1);
  assert.match(d.rendered, /\[HIGH\] octo\/repo pr\/171 ci_status: running -> failed/);
  assert.doesNotMatch(d.rendered, /other\/repo/);
  assert.equal(e.drain("s1"), null, "nothing left after draining");
});

test("stock_threshold: many small decrements coalesce into one line with the condition", () => {
  const e = fresh();
  e.watch({ session: "s1", source: "webhook:shop", account: "store-1", entity: "sku/SKU-5693",
    conditions: [{ field: "on_hand", op: "lt", value: 15 }] });
  let qty = 40;
  for (const dec of [6, 5, 4, 3, 2, 8]) {
    e.ingest(ev({ source: "webhook:shop", account: "store-1", entity: "sku/SKU-5693", type: "inventory.adjusted",
      changes: { on_hand: { from: qty, to: qty - dec } } }));
    qty -= dec;
  }
  const d = e.drain("s1");
  assert.ok(d);
  assert.equal(d.lines.length, 1, "coalesced to a single line");
  assert.match(d.rendered, /on_hand: 40 -> 12 \(condition met: on_hand lt 15\)/);
});

test("condition is not reported while it does not hold", () => {
  const e = fresh();
  e.watch({ session: "s1", source: "webhook:shop", account: "store-1", entity: "sku/A",
    conditions: [{ field: "on_hand", op: "lt", value: 15 }] });
  e.ingest(ev({ source: "webhook:shop", account: "store-1", entity: "sku/A", type: "inventory.adjusted", changes: { on_hand: { from: 40, to: 30 } } }));
  const d = e.drain("s1");
  assert.ok(d);
  assert.doesNotMatch(d.rendered, /condition met/);
});

test("duplicate deliveries of the same event id are ignored", () => {
  const e = fresh();
  e.watch({ session: "s1", source: "github", account: "octo/repo", entity: "pr/1" });
  const x = ev({ entity: "pr/1", type: "ci.run_completed", changes: { ci_status: { from: "running", to: "failed" } } });
  assert.equal(e.ingest(x).size, 1);
  assert.equal(e.ingest({ ...x }).size, 0);
  assert.equal(e.drain("s1")?.lines.length, 1);
});

test("sessions are isolated", () => {
  const e = fresh();
  e.watch({ session: "a", source: "github", account: "octo/repo", entity: "pr/1" });
  e.watch({ session: "b", source: "github", account: "octo/repo", entity: "pr/2" });
  e.ingest(ev({ entity: "pr/1", type: "ci.run_completed", changes: { ci_status: { to: "failed" } } }));
  assert.equal(e.drain("b"), null);
  assert.equal(e.drain("a")?.lines.length, 1);
  assert.equal(e.unwatch("b", e.list("a")[0]!.id), false, "cannot unwatch another session's subscription");
});

test("related entities are low priority and only with includeRelated", () => {
  const e = fresh();
  e.watch({ session: "s1", source: "github", account: "octo/repo", entity: "pr/1", includeRelated: true });
  const urgent = e.ingest(ev({ entity: "pr/9", type: "ci.run_completed", changes: { ci_status: { to: "passed" } } }));
  assert.equal(urgent.size, 0, "low priority does not trigger a push");
  assert.match(e.drain("s1")!.rendered, /\[low\] octo\/repo pr\/9/);
});

test("token budget: HIGH first, the rest stays pending and is counted", () => {
  const e = fresh({ budgetTokens: 60 });
  e.watch({ session: "s1", source: "github", account: "octo/repo", entity: "pr/1", includeRelated: true });
  for (let i = 0; i < 20; i++) e.ingest(ev({ entity: `pr/${100 + i}`, type: "ci.run_completed", changes: { ci_status: { to: "passed" } } }));
  e.ingest(ev({ entity: "pr/1", type: "ci.run_completed", changes: { ci_status: { to: "failed" } } }));
  const d = e.drain("s1")!;
  assert.equal(d.lines[0]!.priority, "HIGH");
  assert.ok(d.omitted > 0);
  assert.match(d.rendered, /more changes pending/);
  assert.ok(e.hasPending("s1"), "omitted lines are not lost");
});

test("subscriptions expire", () => {
  const e = fresh();
  e.watch({ session: "s1", source: "github", account: "octo/repo", entity: "pr/1", ttlMs: 1000 });
  clock += 2000;
  assert.equal(e.list("s1").length, 0);
  assert.equal(e.ingest(ev({ entity: "pr/1", type: "ci.run_completed", changes: { ci_status: { to: "failed" } } })).size, 0);
});

test("a source note is shown, and cleared once a later event resolves the line", () => {
  const e = fresh();
  e.watch({ session: "s1", source: "github", account: "octo/repo", entity: "pr/7" });
  e.ingest(ev({ entity: "pr/7", type: "pr.pushed", note: "CI restarted; result will follow",
    changes: { ci_status: { from: "failed", to: "pending" }, head_sha: { from: "aaa", to: "bbb" } } }));
  assert.match(e.drain("s1")!.rendered, /ci_status: failed -> pending at \S+ \(CI restarted; result will follow\)/);
  e.ingest(ev({ entity: "pr/7", type: "pr.pushed", note: "CI restarted; result will follow",
    changes: { ci_status: { from: "passed", to: "pending" }, head_sha: { from: "bbb", to: "ccc" } } }));
  e.ingest(ev({ entity: "pr/7", type: "ci.status_changed", changes: { ci_status: { from: "pending", to: "failed" } } }));
  const d = e.drain("s1")!;
  assert.match(d.rendered, /ci_status: passed -> failed/);
  assert.doesNotMatch(d.rendered, /result will follow/, "stale note removed after coalescing");
});

test("changes that cancel out produce no delivery at all", () => {
  const e = fresh();
  e.watch({ session: "s1", source: "github", account: "octo/repo", entity: "pr/8" });
  e.ingest(ev({ entity: "pr/8", type: "x", changes: { ci_status: { from: "passed", to: "pending" } } }));
  e.ingest(ev({ entity: "pr/8", type: "x", changes: { ci_status: { from: "pending", to: "passed" } } }));
  assert.equal(e.drain("s1"), null);
});

test("overlapping subscriptions merge an event once (no duplicate text, conditions unioned)", () => {
  const e = fresh({ budgetTokens: 10_000 });
  e.watch({ session: "s1", source: "github", account: "octo/repo", entity: "pr/5", allowTextFrom: ["alice"],
    conditions: [{ field: "on_hand", op: "lt", value: 15 }] });
  e.watch({ session: "s1", source: "github", account: "octo/repo", entity: "pr/5", includeRelated: true,
    conditions: [{ field: "on_hand", op: "lt", value: 5 }] });
  e.ingest(ev({ entity: "pr/5", type: "c", changes: { on_hand: { from: 9, to: 3 } }, text: { author: "alice", body: "hello" } }));
  const d = e.drain("s1")!;
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0]!.texts.length, 1, "text delivered once");
  assert.deepEqual(d.lines[0]!.conditionsMet.sort(), ["on_hand lt 15", "on_hand lt 5"]);
});

test("footer separates pending changes from discarded ones", () => {
  const e = fresh({ budgetTokens: 60, maxPendingPerSession: 5 });
  e.watch({ session: "s1", source: "github", account: "octo/repo", entity: "pr/1", includeRelated: true });
  for (let i = 0; i < 12; i++) e.ingest(ev({ entity: `pr/${300 + i}`, type: "c", changes: { ci_status: { to: "passed" } } }));
  const d = e.drain("s1")!;
  assert.match(d.rendered, /more changes pending/);
  assert.match(d.rendered, /7 older low-priority changes were discarded/);
});

test("restore puts a failed delivery back for get_updates", () => {
  const e = fresh();
  e.watch({ session: "s1", source: "github", account: "octo/repo", entity: "pr/9" });
  e.ingest(ev({ entity: "pr/9", type: "c", changes: { ci_status: { from: "pending", to: "failed" } } }));
  const d = e.drain("s1")!;
  e.restore(d);
  assert.match(e.drain("s1")!.rendered, /pr\/9 ci_status: pending -> failed/);
});

test("subscription limit is enforced", () => {
  const e = fresh({ maxSubscriptions: 2 });
  e.watch({ session: "s", source: "github", account: "a", entity: "1" });
  e.watch({ session: "s", source: "github", account: "a", entity: "2" });
  assert.throws(() => e.watch({ session: "s", source: "github", account: "a", entity: "3" }), /limit/);
});
