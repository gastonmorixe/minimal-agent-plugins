# Prompt cache behavior

Date: 2026-10-04
Plugin: `ma-llm-cursor-plugin`
Authors: Matthew (`68a0d8fb`), Donna (`fcc46867`)
Status: mapper N/A locked 2026-10-04 (Donna `fcc46867`). Count fix landed separately.

## Model

No cache counters reported. Caps inherit defaults with no override: explicit false, automatic false, reports false, disjoint.
- Code: `capabilities.ts` inherits `lib/capabilities.ts:235-242`.

Blind display, not proof of no cache. Proto ConversationTokenDetails only decodes used_tokens#1 and max_tokens#2. Unknown fields are dropped. Do not invent cacheRead.

## Wire

- Sends no `cache_control`. None is ever encoded.
- Tries to keep server cache by not rewriting system.
  - Code: `request-body.ts:9` never rewrite system or bust cache.
  - Lines 338-339 do not send MA system as customSystemPrompt.
  - Lines 343-354 fold system text into single user text via blockText. Drops hints.
  - Line 367 wire mode only, never fold mode policy for cache stability.
  - Lines 348-349 with carried checkpoint send only new user text.

## Usage fields

- Maps only `used_tokens` and `max_tokens` plus token deltas. No cache fields.
  - Code: `cursor-usage.ts:5-8,59-62`.
  - Returns inputTokens and outputTokens 0. No cacheRead or cacheCreate.
- Canonical cache fields exist but cursor never fills them.
  - Code: `lib/canonical-events.ts:41-44`.
- Core legacy mapper exists for Anthropic wire fields only.
  - Code: `minimal-agent-core/src/llm/adapter-legacy-stream.ts:421-422`.

## Token count interaction

- `input_tokens` on cursor is conversation checkpoint `used_tokens`: absolute size, not per turn prefill. Output always 0.
- Old fleet sum showed 248k for 7 tools while window was 37k. Fixed to last turn contextSize.
- See `ma-sub-agents-plugin/docs/fleet-token-count.md`.
- Extra Runs after bidi drop are real spend. Three bodies 236k, 477k, 496k on a 48 tool explorer. Count fix does not remove that cost.

## Live evidence 2026-10-04

- `cursor-auto` rejects all effort flags, even low. Levels are empty. Run without effort.
- Session `b63d615f` is a fork (`parentSid` `d4820109`, `createdAt` 2026-10-04T17:18Z). Turns 1-15 are inherited (ts 16:37, `output_tokens` greater than 0 plus `cache_read_input_tokens`). Those rows are not from `cursorUsageToCanonical` (that mapper always sets `outputTokens` 0). Turns 16+ match the live mapper: output 0, no cache keys. Do not cite this session as Cursor wire cache_read.
- Probe sessions show input 30k to 51k with output 0 and no cache fields.
- Mapper this wave: N/A. Extra-Run folds remain a later spend issue, not a count-map issue.

## Cross refs

- This investigation: `research/2026-10-04-subagent-bugs/findings.md`
- Donna count doc: `ma-sub-agents-plugin/docs/fleet-token-count.md`
