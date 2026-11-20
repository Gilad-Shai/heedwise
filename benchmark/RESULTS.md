# Benchmark v0 results (2026-11-20)

Total spend for all real-model runs was about $18. There were no API errors. The raw per-run
data is written to `results/*/runs.jsonl` when you run the benchmark.

## Background family (primary metric)

### Opus 5.5: 270 runs (3 seeds × 3 noise levels)
| Strategy | Accuracy low / mid / high | Cost low | Cost mid | Cost high |
|---|---|---|---|---|
| **attention** | 100 / 100 / 100 | $0.009 | $0.011 | **$0.010** |
| entity_raw | 100 / 100 / 100 | $0.015 | $0.025 | $0.051 |
| poll | 100 / 100 / 100 | $0.037 | $0.053 | $0.079 |
| firehose | 100 / 100 / 100 | $0.025 | $0.072 | $0.215 |
| static | 50 / 50 / 50 | $0.013 | $0.014 | $0.013 |

### Haiku 5.5: 720 runs (full grid)
| Strategy | Accuracy low / mid / high | Cost mid | Cost high |
|---|---|---|---|
| **attention** | 100 / 100 / 100 | $0.00035 | **$0.00040** |
| entity_raw | 100 / 100 / 100 | $0.00067 | $0.00144 |
| poll | 100 / 100 / 100 | $0.00161 | $0.00222 |
| firehose | 100 / 83 / 100 | $0.00183 | $0.00565 |

### Against the pre-registered rule
Go condition: equal accuracy (±3) at ≥40% lower cost than the best of S1, S2 and S3, at mid or
high noise.
- **Opus:** cost was 55% lower than entity_raw at mid noise and 80% lower at high noise. The condition holds.
- **Haiku:** cost was 48% lower at mid noise and 72% lower at high noise. The condition holds.
- The kill condition (S1 or S3 within ±5% on cost too) does not hold.

**Formal verdict: Go.** In short sessions the advantage is cost only.

## What the short-session results mean
1. **No accuracy advantage in short sessions.** Current models, Haiku included, find the right
   event even inside 78K tokens of noise. What matters is whether the update reaches the agent,
   not its format.
2. **The advantage is cost that does not grow with noise.** The attention layer's cost stays
   flat (about 1 cent on Opus), while every other strategy gets more expensive as noise
   increases. At high noise it is 5x cheaper than entity_raw and 20x cheaper than firehose.
3. **entity_raw is the real competitor.** A naive per-entity subscription gets all the
   accuracy and half the savings. What attention adds on top is salience filtering and coalescing.
4. **The support control shows no bias toward S4.** On Haiku, attention has no advantage there.
   Many early resolutions in Haiku/support (resolving before the event arrives) are a model
   behavior, not a strategy effect.

## Long sessions (30 turns, Haiku 5.5, mid noise, 90 runs, $1.31)
| Strategy | Accuracy | Caught the event (critical) | Acted on stale state | Avg cost | Input tokens |
|---|---|---|---|---|---|
| **attention** | **83%** | **89%** (16/18) | 11% | **$0.0013** | 69K |
| poll | 78% | 78% (14/18) | 22% | $0.0559 (43x) | 1.83M |
| firehose | 61% | 33% (6/18) | 67% | $0.0117 | 444K |
| entity_raw | 50% | 22% (4/18) | 56% | $0.0026 | 110K |
| static | 44% | 0% (0/18) | 89% | $0.0011 | 52K |

**In long sessions, a large accuracy gap appears.** When the event actually happened, attention
caught it in 16 of 18 cases, versus 4 of 18 for entity_raw (Fisher's exact test, p = 0.0001) and
6 of 18 for firehose (p = 0.002). Polling reached similar accuracy (14 of 18, not significantly
different, p = 0.66) at 43x the cost.

The main failure mode: after many quiet, noisy turns, the agent gives up early ("no reply by
the deadline") or misses the event inside the raw stream. Early resolutions: attention 6,
entity_raw 14, firehose 14.

Caveats: one model (Haiku), n = 18 per strategy, one noise level. Some attention errors are
reasoning errors (for example, reordering while stock is still above the threshold) and are
not related to how updates are delivered. Long sessions on Opus have not been run yet.

## Limitations
- The tasks are still simple: an explicit policy and one watched entity.
- One seed for the pilot and three for the grid, so n = 18 per cell. That is enough to see the
  cost trend, but not enough to detect small accuracy differences.
- S4 is rule-based and was written by the people proposing the approach.
