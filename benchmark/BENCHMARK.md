# Agent Attention Benchmark (v0)

## The question
Does an attention layer (session-scoped subscriptions, relevance filtering, compact deltas)
improve an AI agent **measurably**, compared with the usual ways of getting changing data into
an agent today?

## Setup
Each scenario is a multi-turn session. Midway through, a real event happens in the simulated
system and changes the correct final action. At the same time the system produces noise:
unrelated events for the same account, events for other accounts, and **distractors**, which
are events of exactly the same type but for a different account (for example, the same PR
number in another repository).

At the end of the session the agent must call `resolve(action)`. The score is whether the
action is correct. Each template also has a **control** variant, with no critical event but
with a distractor, to catch strategies that make the agent overreact or confuse entities.

All worlds and event streams are deterministic per seed, so every strategy sees exactly the
same events.

### Family 1: background agents (primary)
A scheduler wakes the agent every few minutes. There is no human in the conversation.

| Template | Task | Critical event midway | Correct action (event / no event) |
|---|---|---|---|
| `awaiting_reply` | Wait for a vendor to confirm an invoice in one email thread, in an inbox that also receives unrelated mail | The vendor replies on the thread (approve or dispute) | `pay_invoice` or `hold_invoice` / `send_reminder` |
| `ci_result` | Wait for the CI result of one PR | CI finishes (passed or failed). Distractor: the same PR number in another repo | `merge_pr` or `report_ci_failure` / `notify_ci_delayed` |
| `stock_threshold` | Monitor a SKU's stock against a threshold of 15 | **Cumulative change:** several small decrements, none decisive alone; only the last crosses the threshold | `reorder_stock` / `no_reorder_needed` |

These are modeled on documented cases: an agent waiting for an email reply that has to poll
(anthropics/claude-code#106696), and agents waiting on CI (langchain-ai/langgraph#9046, Open SWE).
`stock_threshold` specifically tests coalescing: raw strategies receive a sequence of events
and must compute the result themselves, while the attention layer delivers one line such as
`on_hand: 21 -> 10`.

### Family 2: live support conversations (control)
A support agent chats with customer Y using scripted messages, to remove noise from the user's
side. Templates: `double_charge`, `order_status`, `upgrade_blocked`, `account_locked`,
`cancel_order`. Each has a mid-conversation event that flips the correct action (for example,
billing auto-reverses the duplicate charge, so no refund should be issued).

In real support products the agent already fetches fresh data through tools at the moment it
needs it, so a large gap here would suggest the benchmark is biased toward S4. This family is
a control.

## Strategies
| # | Name | What the agent receives |
|---|---|---|
| S0 | `static` | A snapshot at session start and nothing after it (the "no real-time" baseline). |
| S1 | `poll` | A `get_customer_state` tool that returns the full current record, including the activity log. The agent decides when to call it. |
| S2 | `firehose` | Every new event in the system (all accounts), as raw JSON, each turn. |
| S3 | `entity_raw` | Every new event for this account only, as raw JSON, each turn. This approximates a naive per-entity subscription plus a re-read. |
| S4 | `attention` | Only meaningful state changes for the watched entity, as a compact delta with `as_of`. **This is the attention layer.** |

In v0, S4 is **deterministic and rule-based**: entity scoping, salience by event type and
watched entity, and rendering as a state diff instead of a log. That is deliberate: if even a
simple version wins, the approach has value. An LLM summarizer is future work.

All strategies share the same base system prompt, the same action tools, and automatic prompt
caching, so the comparison is fair to strategies that grow the context.

## Metrics
- **accuracy**: the share of scenarios where `resolve` is correct (primary).
- **stale rate**: in critical scenarios, the share where the agent acted on the old state.
- **tokens**: input (cache read and cache write counted separately) plus output, per scenario.
- **cost (USD)**: from the model's price list, including cache discounts and long-prompt tiers.
- **API calls and tool calls** per scenario.
- **noise sweep**: everything is measured at three noise levels (low, mid and high events per turn).

## Pre-registered decision rule
The rule was set before any run against a real model, then refocused on the background
family before those runs, once we had evidence that the pain is concentrated there.

- **Go:** in the background family, at mid or high noise, S4 reaches at least +10 points of
  accuracy over the best of S1, S2 and S3, **or** equal accuracy (±3) at ≥40% lower cost.
- **Kill:** in the background family, S1 or S3 is within ±5% of S4 on both accuracy and cost
  at every noise level ("a webhook plus a re-read is enough").
- **Anything in between:** v1 with an LLM summarizer and harder scenarios.

## Known limitations
- This is a simulation, not production traffic. Users are scripted.
- S4 was built by the people proposing the approach, so bias is possible. Mitigations: the
  decision rule was fixed in advance, the code is open, and every strategy shares the same prompt.
- Each run uses one model. We ran both Opus 5.5 and Haiku 5.5.

## Running it
See [README.md](README.md).
