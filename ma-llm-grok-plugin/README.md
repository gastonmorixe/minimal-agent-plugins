# ma-llm-grok-plugin

First-class **Grok / xAI** provider for [minimal-agent](https://github.com/gastonmorixe/minimal-agent-core).

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

Live sources: subscription `cli-chat-proxy` `/v1/models` (grok-4.5 only) and
`api.x.ai/v1/models` (full text catalog + price micros).

| Local id | Wire id | Surface | Context | Vision | Notes |
|----------|---------|---------|---------|--------|-------|
| `grok-4.5` (default) | `grok-4.5` | **Responses** | 500k | yes | Flagship; efforts low/medium/**high** |
| `grok-4.5-chat` | `grok-4.5` | Chat | 500k | yes | Same SKU, chat surface |
| `grok-4.3` | `grok-4.3` | Responses | 1M | yes | Fast / balanced |
| `grok-build` | `grok-build-0.1` | Responses | 256k | yes | Coding; aliases `grok-code-fast*` |
| `grok-4.20-reasoning` | `grok-4.20-0309-reasoning` | Responses | 1M | yes | |
| `grok-4.20-non-reasoning` | `grok-4.20-0309-non-reasoning` | Responses | 1M | yes | No effort knob |
| `grok-4.20-multi-agent` | `grok-4.20-multi-agent-0309` | Responses | 1M | yes | Effort = agent count |

Pricing (under 200k prompt): grok-4.5 **$2 / $0.30 cached / $6** per 1M; doubles at ≥200k.
Prompt-cache accounting is **subset** (OpenAI/xAI): `cached_tokens ⊆ input_tokens`.

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

- `rpm` / `tpm` from `x-ratelimit-*` response headers (captured on every turn)
- `month` from `GET https://cli-chat-proxy.grok.com/v1/billing` (OAuth / session only), when `monthlyLimit > 0`
- `ondemand` from the same `/billing` payload when `onDemandCap > 0`
- Session token usage accumulation for cost estimates

Free / no-included-pool accounts return `monthlyLimit: 0`. We still cache that
response (so we do not re-probe every turn) but omit the `month` bar. Grok CLI’s
weekly `creditUsagePercent` meter is a separate unified-billing shape that is
**not** present on raw `/v1/billing`; it is not shown here yet.

### How monthly billing is populated

1. **`primeSessionInfo` (boot)** — uses the host’s `authKind` + `credentialName`
   (so `--credential-name grok-oauth-3` hits that auth.jsonc entry, not the
   first `grok-oauth`). Falls back to env API key only for api-key sessions.
   For OAuth, hits `/v1/billing` (and `/v1/models` for rate-limit headers).
2. **Adapter (OAuth turns)** — if the billing cache is stale/empty after a
   successful response, fire-and-forget `refreshGrokBillingQuota`.
3. **`fetchSessionInfo`** — cache-only; merges `rpm`/`tpm` + `month` /
   `ondemand` into neutral `QuotaWindow`s for the status bar.

API-key sessions (console keys on `api.x.ai`) do **not** get a `month` window —
that endpoint only exists on cli-chat-proxy.

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
