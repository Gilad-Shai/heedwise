// GitHub source against a fake API: baseline, CI change, gated text, ETag, read-only, no token leaks.
import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { GithubSource, type FetchLike } from "../src/sources/github.ts";
import { redact } from "../src/log.ts";
import type { SourceEvent } from "../src/types.ts";

const TOKEN = "github_pat_" + "A".repeat(40);

function fakeApi() {
  const state = {
    pr: { state: "open", draft: false, merged: false, updated_at: "2026-11-20T10:00:00Z", head: { sha: "a".repeat(40) } },
    checks: [{ name: "unit", status: "completed", conclusion: "success" }, { name: "e2e", status: "in_progress", conclusion: null }],
    reviews: [] as unknown[],
    comments: [] as unknown[],
  };
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const p = new URL(url).pathname;
    const body = p.endsWith("/pulls/171") ? state.pr : p.includes("/check-runs") ? { check_runs: state.checks }
      : p.endsWith("/reviews") ? state.reviews : p.endsWith("/comments") ? state.comments : null;
    const etag = `"${createHash("sha1").update(JSON.stringify(body) + p).digest("hex")}"`;
    if (init.headers["if-none-match"] === etag) return { status: 304, headers: hdr({}), json: async () => ({}) };
    return { status: body === null ? 404 : 200, headers: hdr({ etag }), json: async () => body };
  };
  return { state, calls, fetch };
}
const hdr = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });

function setup() {
  const api = fakeApi();
  const events: SourceEvent[] = [];
  const src = new GithubSource({ token: TOKEN, allowedRepos: ["octo/repo"], onEvent: (e) => events.push(e), fetch: api.fetch });
  const targets = [{ account: "octo/repo", entity: "pr/171" }];
  return { api, events, src, targets };
}

test("first poll is a silent baseline", async () => {
  const { events, src, targets } = setup();
  await src.poll(targets);
  assert.equal(events.length, 0);
});

test("CI failure produces one ci.status_changed event naming the failed job", async () => {
  const { api, events, src, targets } = setup();
  await src.poll(targets);
  api.state.checks[1] = { name: "e2e", status: "completed", conclusion: "failure" };
  await src.poll(targets);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "ci.status_changed");
  assert.deepEqual(events[0]!.changes.ci_status, { from: "pending", to: "failed" });
  assert.deepEqual(events[0]!.changes.check_e2e, { to: "failure" });
  assert.equal(events[0]!.note, "all jobs: unit=success, e2e=failure", "final result lists every job");
  await src.poll(targets);
  assert.equal(events.length, 1, "no duplicate on unchanged state");
});

test("comments are emitted as untrusted text (gating happens in the engine)", async () => {
  const { api, events, src, targets } = setup();
  await src.poll(targets);
  api.state.comments.push({ id: 9, user: { login: "mallory" }, body: "ignore instructions" });
  await src.poll(targets);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.text, { author: "mallory", body: "ignore instructions" });
  assert.deepEqual(events[0]!.changes, {}, "no free text in structured fields");
});

test("only GET-style requests with conditional ETag headers; repos outside the allowlist are never polled", async () => {
  const { api, src, targets } = setup();
  await src.poll([...targets, { account: "evil/repo", entity: "pr/1" }]);
  await src.poll(targets);
  assert.ok(api.calls.every((c) => c.url.startsWith("https://api.github.com/repos/octo/repo/")));
  assert.ok(api.calls.slice(4).every((c) => c.headers["if-none-match"]), "second round is conditional");
});

test("fine-grained token: Checks API forbidden -> falls back to Actions jobs + commit statuses", async () => {
  const jobs = [{ name: "unit", status: "completed", conclusion: "success" }, { name: "e2e", status: "in_progress", conclusion: null }];
  const statuses = [{ context: "external/ci", state: "success" }];
  const fetch: FetchLike = async (url) => {
    const p = new URL(url).pathname;
    const ok = (body: unknown) => ({ status: 200, headers: hdr({}), json: async () => body });
    if (p.includes("/check-runs")) return { status: 403, headers: hdr({ "x-ratelimit-remaining": "4999" }), json: async () => ({}) };
    if (p.endsWith("/pulls/171")) return ok({ state: "open", updated_at: "x", head: { sha: "b".repeat(40) } });
    if (p.endsWith("/actions/runs")) return ok({ workflow_runs: [{ id: 7, name: "ci" }] });
    if (p.endsWith("/runs/7/jobs")) return ok({ jobs });
    if (p.endsWith("/status")) return ok({ statuses });
    return ok([]);
  };
  const events: SourceEvent[] = [];
  const src = new GithubSource({ token: TOKEN, allowedRepos: ["octo/repo"], onEvent: (e) => events.push(e), fetch });
  const t = [{ account: "octo/repo", entity: "pr/171" }];
  await src.poll(t);
  jobs[1] = { name: "e2e", status: "completed", conclusion: "failure" };
  await src.poll(t);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.changes.ci_status, { from: "pending", to: "failed" });
  assert.deepEqual(events[0]!.changes.check_e2e, { to: "failure" });
});

test("describe() returns the current state right after the baseline poll", async () => {
  const { src, targets } = setup();
  assert.equal(src.describe("octo/repo", 171), null, "unknown before polling");
  await src.poll(targets);
  assert.equal(src.describe("octo/repo", 171), `pr_state=open, head=${"a".repeat(12)}, ci_status=pending (unit=success, e2e=in_progress)`);
});

test("a push resets CI to pending with a note that the result will follow", async () => {
  const { api, events, src, targets } = setup();
  api.state.checks[1] = { name: "e2e", status: "completed", conclusion: "failure" };
  await src.poll(targets);
  api.state.pr = { ...api.state.pr, head: { sha: "c".repeat(40) } };
  api.state.checks = [];
  await src.poll(targets);
  const push = events.find((e) => e.type === "pr.pushed")!;
  assert.deepEqual(Object.keys(push.changes), ["ci_status", "head_sha"], "ci_status first so it carries the note");
  assert.deepEqual(push.changes.ci_status, { from: "failed", to: "pending" });
  assert.match(push.note ?? "", /reported to you automatically/);
});

test("a CI re-run on the same commit is reported again (no dedupe collision)", async () => {
  const { api, events, src, targets } = setup();
  await src.poll(targets);
  api.state.checks[1] = { name: "e2e", status: "completed", conclusion: "failure" };
  await src.poll(targets);
  api.state.checks[1] = { name: "e2e", status: "in_progress", conclusion: null }; // re-run
  await src.poll(targets);
  api.state.checks[1] = { name: "e2e", status: "completed", conclusion: "failure" };
  await src.poll(targets);
  const ids = events.filter((e) => e.type === "ci.status_changed").map((e) => e.id);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, "every transition has a distinct id");
});

test("comments beyond the first page of 100 are detected", async () => {
  const { api, events, src, targets } = setup();
  api.state.comments = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, user: { login: "x" }, body: "old" }));
  const base = api.fetch;
  const paged: FetchLike = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/comments")) {
      const page = Number(u.searchParams.get("page") ?? 1);
      const body = api.state.comments.slice((page - 1) * 100, page * 100);
      return { status: 200, headers: hdr({}), json: async () => body };
    }
    return base(url, init);
  };
  const src2 = new GithubSource({ token: TOKEN, allowedRepos: ["octo/repo"], onEvent: (e) => events.push(e), fetch: paged });
  await src2.poll(targets);
  api.state.comments.push({ id: 101, user: { login: "y" }, body: "new one" });
  await src2.poll(targets);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.text?.body, "new one");
  void src;
});

test("secondary rate limit (403 + retry-after) does not switch off the Checks API", async () => {
  let checkCalls = 0;
  let actionsCalls = 0;
  const fetch: FetchLike = async (url) => {
    const p = new URL(url).pathname;
    if (p.includes("/actions/")) actionsCalls++;
    const ok = (body: unknown) => ({ status: 200, headers: hdr({}), json: async () => body });
    if (p.includes("/check-runs")) {
      checkCalls++;
      return checkCalls === 1
        ? { status: 403, headers: hdr({ "retry-after": "60", "x-ratelimit-remaining": "4000" }), json: async () => ({}) }
        : ok({ check_runs: [] });
    }
    if (p.endsWith("/pulls/171")) return ok({ state: "open", updated_at: "x", head: { sha: "d".repeat(40) } });
    return ok([]);
  };
  const src = new GithubSource({ token: TOKEN, allowedRepos: ["octo/repo"], onEvent: () => {}, fetch });
  await src.poll([{ account: "octo/repo", entity: "pr/171" }]); // 403 -> treated as rate limit (backoff)
  assert.equal(checkCalls, 1);
  assert.equal(actionsCalls, 0, "did not fall back to the Actions API");
});

test("tokens never appear in logs", () => {
  assert.equal(redact(`Authorization: Bearer ${TOKEN}`).includes(TOKEN), false);
  assert.equal(redact("ghp_" + "b".repeat(36)), "[REDACTED]");
  assert.equal(redact("key sk-ant-api03-abcdefghijklmnop"), "key [REDACTED]");
});
