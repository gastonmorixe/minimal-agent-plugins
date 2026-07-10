# ma-llm-grok-plugin

First-class **Grok / xAI** provider for [minimal-agent](https://github.com/gastonmorixe/minimal-agent).

Designed against the host architecture (not a Wafer-only copy): dual wire surfaces
like OpenAI, device-code OAuth like OpenAI’s device strategy, session quotas like
HuggingFace/OpenRouter, and a surface codec for generic-endpoint reuse.

## Architecture fit

| Host seam | Implementation |
|-----------|----------------|
| `provider.json` discovery | `id: grok`, export `grokProviderPlugin` |
| `ProviderPlugin.register(ctx)` | `bootstrapGrok` → models + adapter + surface codec |
| `apiKeyAuth` | `grok-api-key` bag → Bearer on `api.x.ai` |
| `oauthLogin.deviceCode` | PIN flow via `auth.x.ai` → cli-chat-proxy base URL |
| `fetchSessionInfo` / `primeSessionInfo` | rate-limit headers + monthly billing window |
| `listLiveModels` | `GET /v1/models` (api.x.ai or proxy) |
| Surfaces | `openai-responses` (preferred frontier) + `openai-chat-completions` |
| Vision | `modalities.image: true` on catalog models |

## Models

| Local id | Wire id | Surface | Context | Vision | Notes |
|----------|---------|---------|---------|--------|-------|
| `grok-4.5` (default) | `grok-4.5` | **Responses** | 500k | yes | Flagship / deep |
| `grok-4.5-chat` | `grok-4.5` | Chat | 500k | yes | Same SKU, chat surface |
| `grok-build` | `grok-build` | Responses | 256k | yes | Coding agent |
| `grok-build-chat` | `grok-build` | Chat | 256k | yes | |
| `grok-composer-2.5-fast` | `grok-composer-2.5-fast` | Chat | 200k | yes | Scout / fast |

## Auth

```bash
# API key (console.x.ai)
minimal-agent provider grok login
# → stores serviceId grok-api-key

# OAuth device PIN (same family as grok login --device-auth)
minimal-agent provider grok login oauth
# → stores serviceId grok-oauth, routes inference to cli-chat-proxy
```

Runtime:

- **api-key** → `https://api.x.ai/v1/{chat/completions\|responses}`
- **oauth** → `https://cli-chat-proxy.grok.com/v1/...` + `X-XAI-Token-Auth: xai-grok-cli` + `x-grok-model-override`

## Quotas (status bar)

- `rpm` / `tpm` from `x-ratelimit-*` response headers  
- `month` from optional `GET /v1/billing` (`setGrokBillingQuota`)  
- Session token usage accumulation for cost estimates  

## Tests

```bash
cd ma-llm-grok-plugin && bun test
```

## Layout

```
adapter.ts           dual-surface ProviderAdapter + ProviderPlugin
auth.ts              API key strategy (+ re-exports OAuth)
oauth-login.ts       device-code PIN + refresh (OAuthLoginProvider)
capabilities.ts      per-model/surface CAPS_* (image/tools/effort)
models.ts            dual registration (responses + chat)
headers.ts           Bearer + session headers
validate.ts          capability preflight (modality, effort, …)
responses/           vendored OpenAI Responses body + SSE translator
surface-codecs.ts    generic-endpoint chat codec
session-info.ts      rate limits + billing + usage
live-models.ts       GET /v1/models
lib/                 vendored plugin-api contracts (no src/ imports)
```
