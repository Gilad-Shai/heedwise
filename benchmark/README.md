# Agent Attention Benchmark

Design and decision rule: [BENCHMARK.md](BENCHMARK.md). Results: [RESULTS.md](RESULTS.md).

## Setup
Requires `uv`. Put your API key in `benchmark/.env` (gitignored):

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Run
```bash
# offline plumbing test (no API calls, numbers are meaningless)
uv run python -m bench.run --mock

# pilot: 80 runs (1 seed, mid noise)
uv run --env-file .env python -m bench.run --seeds 1 --noise mid

# full grid: 720 runs (3 seeds x 3 noise levels)
uv run --env-file .env python -m bench.run

# cheaper model
uv run --env-file .env python -m bench.run --model claude-haiku-5-5

# long background sessions (30 turns) on Haiku
uv run --env-file .env python -m bench.run --model claude-haiku-5-5 --ticks 30 \
  --templates awaiting_reply,ci_result,stock_threshold --noise mid
```

Each run writes `results/<timestamp>-<model>/runs.jsonl` (one row per scenario x strategy) and `summary.md`.

## Layout
- `bench/world.py`: simulated customers, state and event stream (deterministic per seed)
- `bench/scenarios.py`: 5 support templates x {critical, control}; the right action flips mid-session
- `bench/strategies.py`: S0 static, S1 poll, S2 firehose, S3 entity_raw, S4 attention
- `bench/agent.py`: manual Messages API loop that injects updates between customer turns; scoring and cost
- `bench/mock.py`: offline stand-in client
