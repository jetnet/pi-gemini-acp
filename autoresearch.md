# Autoresearch: Improve gemini_search Performance

## Objective
Optimize `gemini_search` latency through systematic experiments. The search involves network calls to Gemini ACP, so we focus on:
1. **Prompt efficiency** - already optimized with "Be concise" prefix
2. **maxResults tuning** - balance between result count and latency
3. **Early-stop optimization** - JSON streaming, abort after complete array
4. **Session warm/caching** - reduce cold-start overhead
5. **Idle TTL tuning** - balance memory vs process restart cost

## Metrics
- **Primary**: `totalMs_p50` (ms, lower is better) — median total search latency
- **Secondary**: `promptMs_p50`, `results`, `wallClockMs`, `initMs`, `sessionMs`

## How to Run
`./autoresearch.sh` — outputs `METRIC name=value` lines.

By default tests warm search with maxResults=5, running 3 times and reporting median.

## Files in Scope
- `src/acp/search-prompt.ts` — search prompt builder (already optimized)
- `src/acp/search-early-stop.ts` — JSON streaming/abort logic
- `src/acp/client-cache.ts` — warm session cache, idle TTL
- `src/acp/session.ts` — ACP process session management
- `scripts/bench.mjs` — existing benchmark harness

## Off Limits
- Do NOT change core search orchestration (run.ts)
- Do NOT change tool schemas or public APIs
- Do NOT add dependencies
- Do NOT break existing tests

## Constraints
- Tests must pass (`npm test`)
- TypeScript must compile (`npm run typecheck`)
- Changes must work in warm mode (most common)
- Network variance is high; need statistical confidence (≥2× noise floor)

## What's Been Tried

### ✅ Completed Optimizations (in baseline):
1. **"Be concise" prompt prefix** — reduces token generation, ~35-65% improvement
2. **maxResults tuning** — fewer results = faster; 3-4 is sweet spot vs default 5

### 🔍 Hypotheses to Test:
1. **Early-stop timing** — Does aborting early on JSON complete actually help?
   - May save token generation time
   - Trade-off: could miss trailing context
2. **Idle TTL extension** — Longer than 15min reduces cold starts
   - Trade-off: memory usage
3. **Session prewarm** — Ensure session warm before search
   - Reduce init + session creation latency
4. **Parallel search** — For independent queries (batch workloads)
5. **Prompt token reduction** — Could we shorten the JSON format spec?

## Learned So Far
- Network variance dominates (2s-20s range), need many runs for signal
- "Be concise" behavioral cue works; prescriptive constraints don't
- Complex aborts/early-stop need careful validation
- Warm session reuse already implemented; focus on keeping it warm
