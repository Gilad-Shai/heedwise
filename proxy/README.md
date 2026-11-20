# Heedwise

**Smart attention for AI agents.** Heedwise watches the systems your agent is waiting on
(GitHub pull requests, CI, webhooks from your own services) and pushes only the changes that
matter into the agent's context: compact, prioritized, and within a token budget. Your agent
stops polling, stops drowning in event streams, and stops acting on stale state.

```
- [HIGH] acme/api pr/171 ci_status: pending -> failed at 2026-11-20T18:21:57Z (all jobs: unit=success, e2e=failure)
```

## Why

Long-running and background agents need to react when something changes: a CI run finishes,
a reviewer comments, stock drops below a threshold. Today they either **poll** (slow, and it
burns tokens re-reading unchanged state) or receive **raw event streams** (noisy, so they miss
what matters). We measured both.

In our benchmark (background agents on Claude Haiku 5.5, 30-turn sessions, medium event
noise; n = 18 per strategy), when the event the agent was waiting for actually happened:

| How the agent got updates | Caught the event | Cost per task |
|---|---|---|
| **Heedwise-style attention layer** | **89%** | **$0.0013** |
| Polling the full record | 78% | $0.0559 (43x) |
| All events, raw (firehose) | 33% | $0.0117 |
| Only this entity's events, raw | 22% | $0.0026 |
| No updates (snapshot at start) | 0% | $0.0011 |

In short sessions every real-time strategy was accurate, and the difference was cost alone
(50–80% fewer tokens). Over long sessions, raw streams made agents give up early or miss the
event. The benchmark, its limits, and the raw results are in [`benchmark/`](https://github.com/Gilad-Shai/heedwise/tree/main/benchmark)
and can be re-run with your own API key.

## How it works

```
 GitHub API ──(read-only polling, ETag)──┐
                                         ├──► Heedwise ──MCP (stdio)──► your agent
 your services ──(signed webhooks)───────┘    │ session-scoped subscriptions
                     127.0.0.1 only           │ salience: watched = HIGH, related = low, rest dropped
                                              │ coalescing: 40 -> 33 -> 24 -> 12 becomes "40 -> 12"
                                              │ conditions: "on_hand lt 15"
                                              └ token budget, dedupe, untrusted-text envelope
```

- **Your agent subscribes** with a tool call ("watch PR 171"). It gets the current state at
  once, then only changes.
- **Changes are pushed** into a running Claude Code session through channels, or pulled with
  `get_updates` from any MCP client.
- **No business data is stored.** Heedwise keeps only subscriptions and seen-event ids.

## Quickstart (Claude Code + GitHub, about 5 minutes)

Requirements: Node.js 22.13 or later, and Claude Code (or any MCP client; see below).

**1. Create a read-only GitHub token.** Go to GitHub → Settings → Developer settings →
Fine-grained tokens. Select **only the repositories** you want to watch. Add these repository
permissions, all **Read-only**: Pull requests, Issues, Actions, Commit statuses. Metadata is
added automatically.

**2. Add Heedwise to your project's `.mcp.json`.** Keep the token in your environment, not in
the file:

```json
{
  "mcpServers": {
    "heedwise": {
      "command": "npx",
      "args": ["-y", "heedwise"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}",
        "HEEDWISE_REPOS": "your-org/your-repo"
      }
    }
  }
}
```

**3. Start Claude Code.**

```bash
export GITHUB_TOKEN=github_pat_...
claude --dangerously-load-development-channels server:heedwise
```

Push delivery uses Claude Code [channels](https://code.claude.com/docs/en/channels), a research
preview. Custom channels are not yet on Anthropic's allowlist, so Claude Code requires this
development flag and shows a warning. Without the flag, Heedwise still works: the agent reads
updates with `get_updates`.

**4. Ask your agent:**

> Watch PR #171 in your-org/your-repo and tell me when CI finishes.

## Tools

| Tool | What it does |
|---|---|
| `watch_github_pr` | Watch a PR: CI result, pushes, state, reviews, comments. Returns the current state. |
| `watch_entity` | Watch an entity that reports through the webhook source (order, SKU, invoice, ticket), with optional conditions such as `on_hand lt 15`. |
| `get_updates` | Read pending changes: compact, HIGH first, within the token budget. |
| `list_watches` / `unwatch` | Manage this session's subscriptions. |

No tool can read files, run commands, or reach network targets chosen by the agent.

## Webhook source (your own systems)

Set `HEEDWISE_WEBHOOK_SECRET` (at least 32 characters), then POST signed JSON to
`http://127.0.0.1:8788/events/<HEEDWISE_WEBHOOK_NAME>`:

```js
import { createHmac } from "node:crypto";
const body = JSON.stringify({
  id: "evt_123",                     // unique; duplicates are ignored
  account: "store-1", entity: "sku/A", type: "inventory.adjusted",
  changes: { on_hand: { from: 20, to: 12 } },
});
const ts = Math.floor(Date.now() / 1000);
const sig = "sha256=" + createHmac("sha256", process.env.HEEDWISE_WEBHOOK_SECRET).update(`${ts}.${body}`).digest("hex");
await fetch("http://127.0.0.1:8788/events/events", { method: "POST", body,
  headers: { "content-type": "application/json", "x-heedwise-timestamp": String(ts), "x-heedwise-signature": sig } });
```

## Configuration

All configuration is through environment variables. Secrets are never accepted as arguments.

| Variable | Default | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | unset | Fine-grained read-only token. Enables the GitHub source. |
| `HEEDWISE_REPOS` | empty | Comma-separated allowlist, e.g. `org/api,org/web`. Other repos cannot be watched. |
| `HEEDWISE_POLL_SECONDS` | `30` | GitHub poll interval (minimum 30). |
| `HEEDWISE_WEBHOOK_SECRET` | unset | Enables the webhook source (at least 32 characters). |
| `HEEDWISE_WEBHOOK_PORT` / `_NAME` | `8788` / `events` | Listener port and path name. |
| `HEEDWISE_PUSH` | `auto` | `auto` pushes to Claude Code only; `on` or `off` forces it. |
| `HEEDWISE_BUDGET_TOKENS` | `400` | Maximum size of one update. |
| `HEEDWISE_STATE_DIR` | `~/.local/state/heedwise` | Location of the small SQLite state file (mode 0600). |

## Security

Heedwise puts text from external systems in front of an agent that may be able to run
commands, so we treat it as a security boundary:

- **Structured fields only, by default.** Comment and review text is withheld unless you
  allowlist its author (`allow_text_from`).
- **Untrusted-text envelope.** Allowed text is truncated, reduced to visible characters
  (which removes Unicode "ASCII smuggling"), and has tags and quotes neutralized.
- **Webhook protection.** The listener binds to 127.0.0.1 only and checks an HMAC signature,
  a 5-minute replay window, the Host header, and rejects any browser Origin.
- **Read-only and local.** There is no telemetry, and tokens never reach logs or disk.

The threat model, test plan, and review log, including a live prompt-injection test against
Claude Code, are in [THREAT_MODEL.md](https://github.com/Gilad-Shai/heedwise/blob/main/THREAT_MODEL.md).
To report a vulnerability, see [SECURITY.md](https://github.com/Gilad-Shai/heedwise/blob/main/SECURITY.md).

## Status

v0.1, early. It works end to end against real GitHub and Claude Code, and has 46 automated
tests, but expect rough edges. On the roadmap: natural-language subscriptions, LLM
summarization of low-priority changes, more sources (Linear, Stripe, Kafka), and MCP
`subscriptions/listen`. Feedback and issues are very welcome.

## License

[Apache-2.0](LICENSE)
