# ma-llm-grok-plugin

First-class **Grok / xAI** provider for [minimal-agent](https://github.com/gastonmorixe/minimal-agent-core).

Designed against the host architecture (not a Wafer-only copy): dual wire surfaces
like OpenAI, device-code OAuth like OpenAI’s device strategy, session quotas like
HuggingFace/OpenRouter, and a surface codec for generic-endpoint reuse.

## Architecture fit

| Host seam                               | Implementation                                                      |
| --------------------------------------- | ------------------------------------------------------------------- |
| `provider.json` discovery               | `id: grok`, export `grokProviderPlugin`                             |
| `ProviderPlugin.register(ctx)`          | `bootstrapGrok` → models + adapter + surface codec                  |
| `apiKeyAuth`                            | `grok-api-key` bag → Bearer on `api.x.ai`                           |
| `oauthLogin.deviceCode`                 | PIN flow via `auth.x.ai` → cli-chat-proxy base URL                  |
| `fetchSessionInfo` / `primeSessionInfo` | rate-limit headers + monthly billing window                         |
| `listLiveModels`                        | `GET /v1/models` (api.x.ai or proxy)                                |
| Surfaces                                | `openai-responses` (preferred frontier) + `openai-chat-completions` |
| Vision                                  | `modalities.image: true` on catalog models                          |

## Models

Live sources (reconciled 2026-08-21): authenticated subscription
`cli-chat-proxy` `/v1/models` + `/models-v2` (grok-4.6 and grok-4.5 listed;
other SKUs still serve inference on `/v1/responses` even though unlisted) and
`api.x.ai/v1/models` (full text catalog + price micros).

Special note on `grok-build` (`grok-build-0.1`): This is a purpose-built agentic coding model
(released May 2026), not a general-purpose model. It is optimized for interactive coding agents,
tool use, and multi-step development workflows. It is the original model behind the Grok Build CLI/TUI.

| Local id                  | Wire id                        | Surface       | Context | Vision | Notes                                 |
| ------------------------- | ------------------------------ | ------------- | ------- | ------ | ------------------------------------- |
| `grok-4.6` (default)        | `grok-4.6`                     | **Responses** | 500k    | yes    | Flagship; efforts low/medium/high/**xhigh** |
| `grok-4.6-chat`             | `grok-4.6`                     | Chat          | 500k    | yes    | Same SKU, chat surface                      |
| `grok-4.5`                  | `grok-4.5`                     | **Responses** | 500k    | yes    | Flagship; efforts low/medium/**high**       |
| `grok-4.5-chat`            | `grok-4.5`                     | Chat          | 500k    | yes    | Same SKU, chat surface                   |
| `grok-4.3`                | `grok-4.3`                     | Responses     | 1M      | yes    | Fast / balanced                       |
| `grok-build`              | `grok-build-0.1`               | Responses     | 256k    | yes    | Agentic coding model (May 2026). Optimized for multi-step software engineering, tool use, and coding agent loops (powers Grok Build CLI). Cheaper/faster than 4.6 but smaller context. Aliases: `grok-code-fast*` |
| `grok-4.20-reasoning`     | `grok-4.20-0309-reasoning`     | Responses     | 1M      | yes    |                                       |
| `grok-4.20-non-reasoning` | `grok-4.20-0309-non-reasoning` | Responses     | 1M      | yes    | No effort knob                        |
| `grok-4.20-multi-agent`   | `grok-4.20-multi-agent-0309`   | Responses     | 1M      | yes    | Effort = agent count                  |

Pricing (under 200k prompt): grok-4.6 **$2 / $0.50 cached / $6** per 1M;
grok-4.5 **$2 / $0.30 cached / $6** per 1M. Both double at ≥200k.
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

On device-code login and every OAuth refresh, the plugin enriches the credential
bag (best-effort) from:

| Endpoint | Persisted fields |
| -------- | ---------------- |
| `GET auth.x.ai/oauth2/userinfo` | `emailAddress`, `displayName`, `givenName`, `familyName`, `emailVerified`, `picture` |
| `GET grok.com/api/auth/session` | `xUserId` (plus identity fallbacks) |
| `GET grok.com/rest/subscriptions` | `plan` (tier), `planStatus`, `planProvider`, `billingPeriodEnd` |

JWT claims still fill `userId` / `principalId` / `teamId` / `jwtTier`. If profile
fetches fail on refresh, prior email/plan fields are kept. xAI rotates refresh
tokens — the new `refreshToken` is always written when returned.

## Quotas (status bar)

- `rpm` / `tpm` from `x-ratelimit-*` response headers (captured on every turn)
- `week` from `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`
  (`config.creditUsagePercent`, weekly unified billing; OAuth / session only)
- `month` from `GET https://cli-chat-proxy.grok.com/v1/billing` (OAuth / session only), when `monthlyLimit > 0`
- `ondemand` from the same `/billing` payload when `onDemandCap > 0`
- Session token usage accumulation for cost estimates

Free / no-included-pool accounts return `monthlyLimit: 0`. We still cache that
response (so we do not re-probe every turn) but omit the `month` bar.

### How monthly billing is populated

1. **`primeSessionInfo` (boot)** — uses the host’s `authKind` + `credentialName`
   (so `--credential-name grok-oauth-3` hits that auth.jsonc entry, not the
   first `grok-oauth`). Falls back to env API key only for api-key sessions.
   For OAuth, hits `/v1/billing` + `/v1/billing?format=credits` (and
   `/v1/models-v2` for rate-limit headers).
2. **Adapter (OAuth turns)** — if a billing cache is stale/empty after a
   successful response, fire-and-forget refresh.
3. **`fetchSessionInfo`** — cache-only; merges `rpm`/`tpm` + `week` / `month` /
   `ondemand` into neutral `QuotaWindow`s for the status bar.

API-key sessions (console keys on `api.x.ai`) do **not** get `week` / `month`
windows — those endpoints only exist on cli-chat-proxy.

## Client headers (cli-chat-proxy)

OAuth requests must carry client identity or the proxy answers HTTP 426:

| Header | Value |
| ------ | ----- |
| `x-grok-client-version` | `1.0.5` (must be ≥ 0.1.202) |
| `x-grok-client-identifier` | `grok-shell` |
| `X-XAI-Token-Auth` | `xai-grok-cli` |
| `x-grok-model-override` | requested model id |

## Tests

```bash
cd ma-llm-grok-plugin && bun test
```

## Layout

```
adapter.ts           dual-surface ProviderAdapter + ProviderPlugin
auth.ts              API key strategy (+ re-exports OAuth)
oauth-login.ts       device-code PIN + refresh (OAuthLoginProvider)
account-profile.ts   userinfo/session/subscriptions → secret fields
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
