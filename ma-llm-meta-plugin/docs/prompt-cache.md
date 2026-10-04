# Prompt cache behavior

Date: 2026-10-04
Plugin: `ma-llm-meta-plugin`
Authors: Matthew (`68a0d8fb`), Jonathan (`b63d615f`)
Status: verified by code, live probes, and muse rev eng.

## Model

Automatic prefix KV cache. No Anthropic style `cache_control` or ephemeral breakpoints. Do not send them. They are stripped.

## Wire

- Default surface is Responses on `https://api.meta.ai/v1/responses` (2026-10-04).
- Chat Completions companion still exists via `lib/openai-chat.ts` / `buildOpenAIChatBody`.
- Content parts carry no `cache_control`. Message map drops `block.cache` by design. Note at `lib/canonical-messages.ts:33-35`.
- `prompt_cache_key` is sent on Responses.
  - Body builder: `vendor.promptCacheKey` or `metadata.sessionId` (`responses/request-body.ts:190-194`).
  - Adapter fallback (2026-10-04): if still unset, `ctx.sessionId`
    (`adapter.ts` Responses branch). Pre-patch `68a0d8fb`: key ABSENT on all 19
    bodies. Post-patch `9c0fd610`: key PRESENT on wire (= sid) — Verified Live.
    Warm hit% still blocked by Muse Code quota until ~21:15Z.
- `prompt_cache_retention` GAP (Verified Offline, 2026-10-04):
  - Meta docs and Jonathan RE allow Responses values `in_memory` | `24h` (hint, not guarantee).
  - Canonical field exists: `lib/canonical-request.ts:129` `promptCacheRetention`.
  - Meta Responses builder never writes `body.prompt_cache_retention`.
  - OpenAI sibling DOES wire it: `ma-llm-openai-plugin/responses/request-body.ts:269-270`.
  - Prior wording in this file that claimed retention was optional on the wire was wrong. Declared, not sent.

## Usage fields

- Chat: `usage.prompt_tokens_details.cached_tokens` maps to `cacheReadTokens`.
  - Code: `lib/openai-chat.ts:339-341`.
- Responses: `usage.input_tokens_details.cached_tokens` maps to `cacheReadTokens`.
  - Code: `responses/response-stream.ts:191-197,502-503`.
- No `cache_creation` split. Meta reports single `cached_tokens` subset of input, not Anthropic write plus read pair. Zeros in create are normal.
- Tracker keeps input, output, cacheRead only.
  - Code: `session-info.ts:56-74`.

## Cache rules

- Match from START of tokenized prompt. First differing token ends the hit.
- Keep system and tools stable and first. Put user turn last.
- Volatile early content kills hits.
- `cached_tokens: 0` on cold turns is expected. It means miss, cold, or evicted. Not hidden.
- Min prefix 1024 in our `capabilities.ts` is a client heuristic, Assumed, not Meta server documented. Jonathan confirms it is absent from official docs and Muse binary mine.

## Live evidence 2026-10-04

Early Chat era snapshots:
- Lead session mid run: 32 turns, input sum 2.18M, read sum 223k near 10 percent, last turn in 98k with 69k read.
- First turn probe: input 45717, read 0. Cold start normal.
- Second turn resume fell back to cursor, so no valid meta turn 2.
- Worker with 7 turns: read 4.7k near 1 percent, last in 59k read 0.
- Worker with 6 turns: read 44k near 15 percent.

Responses era on same lead session `68a0d8fb` (Verified Live):
- 176 billed assistant turns.
- Input sum 22,055,474. Cache read sum 6,509,346. Hit rate 29.5 percent.
- 66 turns with read greater than 0.
- Recent last 5: mostly read 0, one turn read 4721 on input 173592.
- Verdict: Responses READ path works. Recent near zero reads are miss, eviction, or prefix churn. Not a mapping bug. Retention still unwired.

## Cross refs

- Jonathan reports: `research/meta-harness/docs/meta-cache.md`, `findings/04-meta-cache.md`, `findings/agent-outputs/04-cache-strings.md`.
- Official: https://dev.meta.ai/docs/prompt-caching and https://dev.meta.ai/docs/pricing-rate-limits
- This investigation: `research/2026-10-04-subagent-bugs/findings.md`
