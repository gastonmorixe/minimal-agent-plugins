# Grok CLI / cli-chat-proxy RE findings — 2026-08-21

Consolidated ground truth gathered live (OAuth `grok-oauth-9`, refreshed via
`auth.x.ai/oauth2/token`) plus binary strings from
`~/.grok/downloads/grok-1.0.5-macos-aarch64` (Rust, 1.0.5). Companion to the
older 0.2.93 analysis in `~/Projects/grok/api/research/`.

## Live catalog (GET https://cli-chat-proxy.grok.com/v1/models)

Exactly two models listed:

| id | ctx | backend | efforts (default) |
| -- | --- | ------- | ----------------- |
| grok-4.6 | 500000 | responses | xhigh, **high**, medium, low |
| grok-4.5 | 500000 | responses | **high**, medium, low |

Both: `auto_compact_threshold_percent: 80`, `supports_backend_search: true`,
`compactions_remaining: 1`, `compaction_at_tokens: true`.

**Unlisted SKUs still serve inference** (verified HTTP 200 on
`POST /v1/responses`): `grok-4.3`, `grok-build-0.1`, `grok-4.20-reasoning`.
Do not prune them from the registry.

Wire quirk: requesting `grok-4.6` returns `"model": "grok-4.6-build"` in the
response object.

## Client headers (required)

Requests without client identity get **HTTP 426**
`"Your Grok CLI version (none) is outdated..."`. Working set:

```
Authorization: Bearer <token>
X-XAI-Token-Auth: xai-grok-cli
x-grok-client-version: 1.0.5      # must be >= 0.1.202
x-grok-client-identifier: grok-shell
x-grok-model-override: <model>    # routing; safe to always send
```

Other headers seen in binary: `x-grok-session-id`, `x-grok-turn-id`,
`x-grok-agent-id`, `x-grok-conv-idx`, `x-grok-req-idx`,
`x-grok-doom-loop-check`, `x-grok-context-window`, `x-grok-max-completion-tokens`,
`x-grok-deployment-id`, `x-grok-user-id`, `x-grok-client-mode`,
`x-authenticateresponse: authenticate-response`, `x-models-etag`.

## Endpoints (all verified 200 with OAuth token)

| Path | Notes |
| ---- | ----- |
| `/v1/models` | core catalog |
| `/v1/models-v2` | same + `supported_in_api`, `hidden`, `agent_type`, `laziness_detector` |
| `/v1/settings` | remote feature flags (see below) |
| `/v1/billing` | monthly: `monthlyLimit`, `used`, `onDemandCap`, history |
| `/v1/billing?format=credits` | weekly unified billing (see below) |
| `/v1/feedback/config`, `/v1/login-config`, `/v1/subagents/bundle` | unchanged from 0.2.93 RE |
| `/v1/responses`, `/v1/chat/completions` | inference |

## Weekly credits billing (`?format=credits`)

```json
{"config": {
  "currentPeriod": {"type": "USAGE_PERIOD_TYPE_WEEKLY",
    "start": "...", "end": "..."},
  "creditUsagePercent": 20.0,
  "productUsage": [{"product": "GrokBuild", "usagePercent": 20.0}],
  "isUnifiedBillingUser": true,
  "prepaidBalance": {"val": 0},
  "topUpMethod": "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
  "onDemandCap": {"val": 0}, "onDemandUsed": {"val": 0}
}}
```

Monthly (`/v1/billing`) sample for a SuperGrok account: `monthlyLimit.val: 0`
(no hard cap), `used.val: 54`, period = calendar month.

## Remote settings highlights

`subscription_tier_display: "SuperGrok"`, `default_model: "grok-4.6"`,
`min_client_version: "0.1.202"` (enforced via 426), `force_update: true`,
`compaction_mode: "segments"`, `inference_idle_timeout_secs: 3600`,
`image_gen_enabled: true`, `video_gen_enabled: true`, `show_thinking_blocks: true`,
`subagents_enabled: true`, `max_upload_file_bytes: 1073741824`.

## Auth refresh

Token endpoint is **`https://auth.x.ai/oauth2/token`** (NOT `/oauth/token`;
that path 403s behind Cloudflare). Form-encoded POST:
`grant_type=refresh_token&refresh_token=…&client_id=…`. Returns new
`access_token` + rotated `refresh_token`. Discovery at
`https://auth.x.ai/.well-known/openid-configuration`.

## Binary extras (1.0.5 strings)

- Subscription tiers enum: `supergrok`, `supergrok_lite`, `supergrok_plus`,
  `supergrok_heavy`, `x_premium`, `x_premium_plus`.
- Per-model config fields parsed by the CLI: `modelFamily`, `baseUrl`,
  `contextWindow`, `apiBackend`, `maxCompletionTokens`, `apiKey`, `envKey`,
  `autoCompactThresholdPercent`, `systemPromptLabel`, `extraHeaders`,
  `apiBaseUrl`, `useConcise`, `inferenceIdleTimeoutSecs`, `maxRetries`,
  `supportedInApi`, `supportsBackendSearch`, `compactionsRemaining`,
  `compactionAtTokens`, `showModelFingerprint`, `streamToolCalls`,
  `laziness_detector{max_nudges_per_session,idle_threshold_ms,...}`,
  `system_prompt_type`.
- Billing fields: `creditUsagePercent`, `monthlyLimit`, `onDemandCap`,
  `onDemandUsed`, `prepaidBalance`, `isUnifiedBillingUser`, `history`,
  `billingCycle`, `includedUsed`, `totalUsed`, `subscription_tier`.
- Env vars of interest: `GROK_CLI_CHAT_PROXY_BASE_URL`, `GROK_XAI_API_BASE_URL`,
  `GROK_CODE_BACKEND_URL` (code.grok.com), `GROK_COMPACTION_MODE`,
  `GROK_WORKSPACES_BASE_URL`, `XAI_API_KEY`.
- Websocket: `wss://computer-hub.grok.com/v1/tools` (workspace hub),
  `wss://code.grok.com/ws/code-agent`.
- Storage: GCS/S3 multipart upload clients (`/storage/multipart/init|complete`,
  signed-URL direct or proxy modes) for session traces/codebase snapshots.
- Subagent personas fetched from `/v1/subagents/bundle`; researcher persona
  still pins `model = "grok-build"` server-side even though unlisted in
  `/models` (it still works — see above).

## Refresh checklist for next time

1. Refresh token via `auth.x.ai/oauth2/token` (form-encoded).
2. `GET /v1/models-v2` → diff effort ladders + context windows vs
   `capabilities.ts`.
3. Probe unlisted SKUs on `/v1/responses` before pruning anything.
4. Check `/v1/settings` → `min_client_version`, `default_model`,
   `subscription_tier_display`.
5. Check both `/v1/billing` shapes for quota-window changes.
