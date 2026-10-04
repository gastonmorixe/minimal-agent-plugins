# Prompt cache behavior

Date: 2026-10-04
Plugin: `ma-llm-openai-plugin`
Author: Matthew (`68a0d8fb`)
Status: verified by code and live probes.

## Model

Automatic prefix cache. Never send `cache_control`. Request carries only routing keys.

## Wire

- Responses: `prompt_cache_key` plus optional `prompt_cache_retention`.
  - Code: `responses/request-body.ts:65,67,268-271`.
  - Adapter fallback to session id: `lib/adapter.ts:129-131`.
- Chat body has no cache fields at all.
  - Code: `chat/request-body.ts:34-55`.
- System text join reads only block text. Per block cache hints drop silent by design.
  - Code: `chat/request-body.ts:181-183`, `lib/openai-chat.ts:683`, `responses/request-body.ts:291-292`.
  - Note at `lib/canonical-messages.ts:33-35`.

## Usage fields

- Chat: `usage.prompt_tokens_details.cached_tokens` maps to `cacheReadTokens`.
  - Code: `lib/openai-chat.ts:104,339-341`.
- Responses: `usage.input_tokens_details.cached_tokens`.
  - Code: `responses/response-stream.ts:192,501-503`.
- Caps: automatic true, explicit false, reports true, subset accounting, min prefix 1024 heuristic.
  - Code: `lib/capabilities.ts:13-14,27-34`.
- Pricing notes subset accounting. Cached tokens are reads only.
  - Code: `pricing.ts:127`.

## Cache rules

- Same prefix rule as meta: match from start, first diff ends hit.
- Stable system and tools first. User turn last.
- Cold first turn reads 0. Normal.

## Live evidence 2026-10-04

- Early probe: first turn cold (read 0). Another window: one ~63% hit then drops — initially blamed on prefix churn.
- Fingerprint on busy session `325ea6a7` (64 Responses bodies, Verified Live):
  - `prompt_cache_key` PRESENT all 64 (= sid).
  - instructions/tools **1 hash**; input **63/63 append-only**; early prefix stable once `input_len ≥ 50`.
  - `prompt_cache_retention` never set (wired, unused).
  - last-3 hit% **17.4**, last-10 **19.9**, lifetime **18.9** with multi-turn 0% streaks.
- Verdict update: byte-prefix churn (H1/H2/H3) **falsified** on this session. Unstable hits are **H4** (eviction/routing) despite key + stable prefix. Same class as Meta `68a0d8fb`. Details: `research/2026-10-04-subagent-bugs/prefix-stability-results.md` § OpenAI.

## Cross refs

- This investigation: `research/2026-10-04-subagent-bugs/findings.md`
- Prefix/last-N table: `research/2026-10-04-subagent-bugs/prefix-stability-results.md`
- Sub-agents count fix: `ma-sub-agents-plugin/docs/fleet-token-count.md`
