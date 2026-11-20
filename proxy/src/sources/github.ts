// GitHub source: polls watched pull requests and turns changes into SourceEvents.
// Read-only by construction: only GET requests are ever made.
// The first poll of a PR records a baseline and emits nothing, so watching a PR
// does not replay its history. Free text (reviews, comments) is attached as
// `text` and the engine only delivers it from allowlisted authors.
import { log } from "../log.ts";
import { identifier } from "../sanitize.ts";
import type { SourceEvent } from "../types.ts";

export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface GithubOptions {
  token: string;
  /** Repos the user allows to be watched ("owner/repo"). Everything else is ignored. */
  allowedRepos: string[];
  onEvent: (ev: SourceEvent) => void;
  fetch?: FetchLike;
  apiBase?: string;
}

interface PrState {
  baseline: boolean;
  prState?: string;
  headSha?: string;
  ciStatus?: string;
  /** Counts CI transitions so a re-run on the same commit gets a new event id. */
  ciSeq: number;
  checks: Map<string, string>;
  seenReviews: Set<number>;
  seenComments: Set<number>;
}

export const MIN_POLL_INTERVAL_MS = 30_000;
const SOURCE = "github";
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export class GithubSource {
  #opts: GithubOptions;
  #fetch: FetchLike;
  #api: string;
  #state = new Map<string, PrState>();
  #etags = new Map<string, { etag: string; body: unknown }>();
  #warnedScopes = false;
  #backoffUntil = 0;
  #ciMode: "checks" | "actions" = "checks";

  constructor(opts: GithubOptions) {
    if (!opts.token) throw new Error("GITHUB_TOKEN is required for the GitHub source");
    for (const r of opts.allowedRepos) if (!REPO.test(r)) throw new Error(`invalid repo in allowlist: ${r}`);
    this.#opts = opts;
    this.#fetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.#api = opts.apiBase ?? "https://api.github.com";
  }

  /** Current known state of a watched PR (after at least one poll), sanitized for the agent. */
  describe(repo: string, n: number): string | null {
    const st = this.#state.get(`${repo}#${n}`);
    if (!st || st.prState === undefined) return null;
    const checks = [...st.checks.entries()].map(([k, v]) => `${identifier(safeName(k))}=${identifier(v)}`).join(", ");
    return `pr_state=${identifier(st.prState)}, head=${identifier((st.headSha ?? "").slice(0, 12))}, ` +
      `ci_status=${identifier(st.ciStatus ?? "unknown")}${checks ? ` (${checks})` : ""}`;
  }

  isAllowed(repo: string): boolean {
    return this.#opts.allowedRepos.includes(repo);
  }

  /** Poll each (repo, pr) once. Targets come from the engine's active subscriptions. */
  async poll(targets: { account: string; entity: string }[]): Promise<void> {
    if (Date.now() < this.#backoffUntil) return;
    const unique = new Map(targets.map((t) => [`${t.account}|${t.entity}`, t]));
    for (const t of unique.values()) {
      const m = /^pr\/(\d{1,9})$/.exec(t.entity);
      if (!m || !this.isAllowed(t.account)) continue;
      try {
        await this.#pollPr(t.account, Number(m[1]));
      } catch (e) {
        log(`GitHub poll failed for ${t.account}#${m[1]}: ${e instanceof Error ? e.message : "error"}`);
      }
    }
  }

  async #pollPr(repo: string, n: number): Promise<void> {
    const key = `${repo}#${n}`;
    let st = this.#state.get(key);
    if (!st) this.#state.set(key, (st = { baseline: true, ciSeq: 0, checks: new Map(), seenReviews: new Set(), seenComments: new Set() }));
    const emit = (id: string, type: string, changes: SourceEvent["changes"], text?: SourceEvent["text"], note?: string) => {
      if (st.baseline) return;
      this.#opts.onEvent({ id: `github:${key}:${id}`, source: SOURCE, account: repo, entity: `pr/${n}`, type,
        ts: new Date().toISOString(), changes, ...(text ? { text } : {}), ...(note ? { note } : {}) });
    };

    const pr = (await this.#get(`/repos/${repo}/pulls/${n}`)) as {
      state: string; merged?: boolean; draft?: boolean; updated_at: string; head: { sha: string };
    } | null;
    if (!pr) return;
    const prState = pr.merged ? "merged" : pr.state === "open" && pr.draft ? "draft" : pr.state;
    if (st.prState !== undefined && st.prState !== prState) {
      emit(`state:${prState}:${pr.updated_at}`, "pr.state_changed", { pr_state: { from: st.prState, to: prState } });
    }
    st.prState = prState;

    const sha = pr.head.sha;
    if (st.headSha !== undefined && st.headSha !== sha) {
      // ci_status first: the engine attaches the note to the first change.
      emit(`head:${sha}`, "pr.pushed", {
        ci_status: { from: st.ciStatus ?? "unknown", to: "pending" },
        head_sha: { from: st.headSha.slice(0, 12), to: sha.slice(0, 12) },
      }, undefined, "new commit pushed; CI restarted. Its result will be reported to you automatically when it finishes");
      st.checks.clear();
      st.ciStatus = "pending";
    }
    st.headSha = sha;

    const runs = await this.#ciResults(repo, sha);
    if (runs) {
      const failedNow: string[] = [];
      for (const [name, v] of runs) {
        const prev = st.checks.get(name);
        if (prev !== v && FAILED.has(v)) failedNow.push(name);
        st.checks.set(name, v);
      }
      const agg = aggregate([...st.checks.values()]);
      if (st.ciStatus !== undefined && st.ciStatus !== agg) {
        const changes: SourceEvent["changes"] = { ci_status: { from: st.ciStatus, to: agg } };
        for (const name of failedNow.slice(0, 5)) changes[`check_${safeName(name)}`] = { to: st.checks.get(name) ?? "failure" };
        // On a final result, list every job so the agent does not have to look the rest up.
        // Job names can be attacker-controlled (fork PRs), so they are sanitized like any field.
        const all = [...st.checks.entries()].slice(0, 10).map(([k, v]) => `${identifier(safeName(k))}=${identifier(v)}`).join(", ");
        const note = agg !== "pending" && all ? `all jobs: ${all}${st.checks.size > 10 ? ", ..." : ""}` : undefined;
        emit(`ci:${sha}:${agg}:${++st.ciSeq}`, "ci.status_changed", changes, undefined, note);
      }
      st.ciStatus = agg;
    }

    const reviews = (await this.#getAll(`/repos/${repo}/pulls/${n}/reviews`)) as {
      id: number; user: { login: string } | null; state: string; body: string | null;
    }[] | null;
    for (const r of reviews ?? []) {
      if (st.seenReviews.has(r.id)) continue;
      st.seenReviews.add(r.id);
      const login = r.user?.login ?? "unknown";
      emit(`review:${r.id}`, "pr.review", { [`review_${safeName(login)}`]: { to: r.state.toLowerCase() } },
        r.body ? { author: login, body: r.body } : undefined);
    }

    const comments = (await this.#getAll(`/repos/${repo}/issues/${n}/comments`)) as {
      id: number; user: { login: string } | null; body: string | null;
    }[] | null;
    for (const c of comments ?? []) {
      if (st.seenComments.has(c.id)) continue;
      st.seenComments.add(c.id);
      emit(`comment:${c.id}`, "pr.comment", {}, { author: c.user?.login ?? "unknown", body: c.body ?? "" });
    }

    st.baseline = false;
  }

  /**
   * CI results for a commit as name -> conclusion (or status while running).
   * Uses the Checks API when the token allows it. Fine-grained personal access
   * tokens have no "Checks" permission (403), so we then switch for good to the
   * Actions API (workflow jobs) plus commit statuses (external CI systems).
   */
  async #ciResults(repo: string, sha: string): Promise<Map<string, string> | null> {
    const out = new Map<string, string>();
    if (this.#ciMode === "checks") {
      const runs = (await this.#get(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`, { allowForbidden: true })) as {
        check_runs: { name: string; status: string; conclusion: string | null }[];
      } | null | "forbidden";
      if (runs !== "forbidden") {
        for (const r of runs?.check_runs ?? []) out.set(r.name, r.status === "completed" ? (r.conclusion ?? "unknown") : r.status);
        return runs ? out : null;
      }
      this.#ciMode = "actions";
      log("Checks API not permitted for this token; reading CI through the Actions API and commit statuses instead");
    }
    const wf = (await this.#get(`/repos/${repo}/actions/runs?head_sha=${sha}&per_page=20`)) as {
      workflow_runs: { id: number; name: string | null }[];
    } | null;
    const runs = wf?.workflow_runs ?? [];
    // Two workflows can both have a job called e.g. "build"; prefix with the workflow
    // name when more than one ran so one result cannot mask the other.
    const prefix = new Set(runs.map((r) => r.name)).size > 1;
    for (const run of runs) {
      const jobs = (await this.#get(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`)) as {
        jobs: { name: string; status: string; conclusion: string | null }[];
      } | null;
      for (const j of jobs?.jobs ?? []) {
        const name = prefix ? `${run.name ?? "workflow"}/${j.name}` : j.name;
        out.set(name, j.status === "completed" ? (j.conclusion ?? "unknown") : j.status);
      }
    }
    const combined = (await this.#get(`/repos/${repo}/commits/${sha}/status`)) as {
      statuses: { context: string; state: string }[];
    } | null;
    for (const s of combined?.statuses ?? []) out.set(s.context, STATUS_MAP[s.state] ?? s.state);
    return wf || combined ? out : null;
  }

  /** Follow pages (oldest first, as GitHub returns them) so new items past the first 100 are seen. */
  async #getAll(path: string, maxPages = 10): Promise<unknown[] | null> {
    const all: unknown[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const items = (await this.#get(`${path}?per_page=100&page=${page}`)) as unknown[] | null;
      if (!items) return page === 1 ? null : all;
      all.push(...items);
      if (items.length < 100) break;
    }
    return all;
  }

  /** GET with ETag caching (304s don't count against the rate limit). Returns null on 404. */
  async #get(path: string, opts: { allowForbidden?: boolean } = {}): Promise<unknown> {
    const url = this.#api + path;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#opts.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "heedwise",
    };
    const cached = this.#etags.get(url);
    if (cached) headers["if-none-match"] = cached.etag;
    const res = await this.#fetch(url, { headers });
    this.#checkScopes(res.headers.get("x-oauth-scopes"));
    if (res.status === 304 && cached) return cached.body;
    if (res.status === 404) return null;
    // Primary and secondary rate limits must not be mistaken for "no permission".
    const rateLimited = res.status === 429 || res.headers.get("x-ratelimit-remaining") === "0" ||
      res.headers.get("retry-after") !== null;
    if (res.status === 403 && !rateLimited && opts.allowForbidden) return "forbidden";
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      this.#backoffUntil = Math.max(Date.now() + 60_000, reset);
      throw new Error(`rate limited (HTTP ${res.status})`);
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`); // never echo the body
    const body = await res.json();
    const etag = res.headers.get("etag");
    if (etag) this.#etags.set(url, { etag, body });
    return body;
  }

  #checkScopes(scopes: string | null) {
    if (this.#warnedScopes || scopes === null) return;
    this.#warnedScopes = true;
    if (/\b(repo|write:|admin:|delete_repo|workflow)\b/.test(scopes)) {
      log("WARNING: the GitHub token has write/admin scopes. Use a fine-grained, read-only token scoped to the watched repos.");
    }
  }
}

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const PASSED = new Set(["success", "neutral", "skipped"]);
// Commit status states -> check-style conclusions.
const STATUS_MAP: Record<string, string> = { success: "success", failure: "failure", error: "failure", pending: "in_progress" };

function aggregate(values: string[]): string {
  if (values.length === 0) return "pending";
  if (values.some((v) => FAILED.has(v))) return "failed";
  if (values.every((v) => PASSED.has(v))) return "passed";
  return "pending";
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 32);
}
