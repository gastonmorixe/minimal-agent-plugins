# Prompt cache behavior

Date: 2026-10-04
Plugin: `ma-llm-grok-plugin`
Author: Matthew (`68a0d8fb`)
Status: verified by code. No live data: quota dead plus 3 creds dead.

## Model

Automatic cache with sticky routing key. No `cache_control` on wire.

## Wire

- Builders never emit `cache_control`.
  - Note: `lib/canonical-messages.ts:34` says OpenAI adapters drop it because cache is automatic.
  - `lib/openai-chat.ts` mentions cache only on usage lines 339-340. No send path.
  - `responses/request-body.ts` has zero `cache_control` hits. System flattens to plain text at 244-248.
- Routing key instead of markers:
  - Code: `responses/request-body.ts:63,230`.
  - Comment at 60: sticky cache routing.
  - Source at 226-229: `vendor.promptCacheKey` or `metadata.sessionId`.
  - Test at `grok.test.ts:428,442` sends key equals sess-1.

## Usage fields

- Chat: `prompt_tokens_details.cached_tokens` maps to `cacheReadTokens`.
  - Code: `lib/openai-chat.ts:104,339-340`.
- Responses: `input_tokens_details.cached_tokens` maps to `cacheReadTokens`.
  - Code: `responses/response-stream.ts:191,500-501`.
- Merge at 517 passes `cacheCreationTokens` through but never sets it from wire. Create stays empty.
- Fixture shows `cached_tokens: 0`.
  - Code: `__fixtures__/chat-pong.sse:7`.

## Live evidence 2026-10-04

- None. First probe timed out. Net body says quota exhausted: 661817 over 600000 on grok-4.7.
- Retries with `grok-oauth-10`, `grok-oauth-2`, `grok-oauth-3` all failed: `invalid_grant` refresh token.
- Needs fresh cred plus quota reset before live numbers exist.

## Cross refs

- This investigation: `research/2026-10-04-subagent-bugs/findings.md`
- Sub-agents count fix: `ma-sub-agents-plugin/docs/fleet-token-count.md`
