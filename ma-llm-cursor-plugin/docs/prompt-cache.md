# Prompt cache behavior

Date: 2026-11-15 (update)
Plugin: `ma-llm-cursor-plugin`
Status: wire cache decode landed (TurnEnded / ModelCallCompleted).

## Model

Server-side automatic prompt cache. No client `cache_control`.

- Caps: `caching.automatic = true`, `reportsCacheHits = true`, `explicit = false`.
- Code: `capabilities.ts` → `cursorCaps()`.

## Wire (cursor-agent 2026.11.13-eacade1)

- `InteractionUpdate.turn_ended` (#14) `TurnEndedUpdate`:
  `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`.
- `InteractionUpdate.model_call_completed` (#31) `ModelCallCompletedUpdate`:
  `model_call_id` + same token fields.
- Official CLI `$()`: `inputTokens = max(wireInput - cacheRead - cacheWrite, 0)` then maps
  cache write → creation, cache read → read. **Wire input includes cache.**
- Latest `model_call_completed` **replaces** prior call totals (not summed) so
  `contextSize` stays one-prompt footprint.
- `ConversationTokenDetails.max_tokens` is surfaced as `ProviderSessionInfo.contextWindow`
  so the status bar denominator matches the server window. When `used_tokens > max_tokens`
  (Auto can grow past catalog 128k), the denominator follows `used_tokens` so the bar
  never reads `128k … 143k`.

## Usage mapping

- Prefer TurnEnded / ModelCallCompleted → CanonicalUsage with disjoint cache fields.
- Fallback: checkpoint `used_tokens` as absolute occupancy, `outputTokens` 0, no invented cache.
- Code: `cursor-usage.ts`, decode in `proto/agent-run.ts`.

## Live evidence 2026-11-15 (this MA session `c0cc6863…`)

`DashboardService/GetFilteredUsageEvents` for `conversationId = c0cc6863-0000-4000-8000-e73f0371c5f0`:

| ts (approx) | input | output | cacheRead |
|---|---:|---:|---:|
| latest | 192728 | 7147 | 1678336 |
| prior | 142866 | 355 | 286208 |

Local SessionInfo before fix: `cache-read 0`, `189k / 128k` (148%). Cursor billing
proves cache is live; the provider simply was not decoding it.

`GetTokenUsage` by `usageUuid` returns only input/output (drops cache) — prefer
`GetFilteredUsageEvents.tokenUsage` for post-hoc cache debug.

## Cross refs

- RE extract: `~/Projects/vendor-research/2026.11.13-eacade1/`
- Research scripts: `.../scripts/dashboard-self-apis/`
