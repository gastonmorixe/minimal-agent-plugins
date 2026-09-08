# ma-llm-meta-plugin

First-class **Meta Model API** (Muse Spark) provider for
[minimal-agent](https://github.com/gastonmorixe/minimal-agent-core).

OpenAI-compatible Chat Completions against `https://api.meta.ai/v1`. Supports
**Muse Code OAuth** (device code, same flow as the Muse CLI) and **Model API
keys** (`LLM_…`). Do **not** use the retired Llama API (`api.llama.com` /
`LLAMA_API_KEY`).

## Quick start

### Muse Code subscription (OAuth)

If you have Muse Code Everyday / High / Power:

```bash
minimal-agent provider meta login
# opens Meta device sign-in; enter the shown code
```

Flow (same shape as Muse CLI):

1. OIDC device code at `auth.meta.com`
2. Mint a Model API key at `https://api.meta.ai/muse-code/key` (**Inferred** path from binary strings)
3. Store under credential name **Muse Code (OAuth)** in minimal-agent's auth store

Runtime auth uses the **minted API key** as Bearer on `api.meta.ai`, not the raw OIDC token.


### Model API key (pay-as-you-go)

1. Create a key at [dev.meta.ai](https://dev.meta.ai/) (US preview; payment method required).
2. Login:

```bash
minimal-agent provider meta login api-key
# paste LLM_… key
```

Or export for priming:

```bash
export MODEL_API_KEY='LLM_…'   # official Meta env name
# also accepted for session prime: META_API_KEY, MINIMAL_AGENT_META_API_KEY
```

3. Run with a Muse Spark model:

```bash
minimal-agent --provider meta --model muse-spark-1.2
```

## Models (live `GET /v1/models`, 2026-08-05)

| Id | Context | Pricing / 1M (in / cached / out) | Notes |
| --- | --- | --- | --- |
| `muse-spark-1.2` (default) | 1M | $1.25 / $0.15 / $4.25 | Flagship coding / agentic · multimodal: image + video + PDF |
| `muse-spark-1.1` | 1M | $1.25 / $0.15 / $4.25 | Multimodal: image + video + PDF |
| `muse-spark-1.2-contributor` | 1M | $0.10 / $0.002 / $0.20 | Cheap; **trains on your data**; 60 RPM · multimodal: image + video + PDF |

Aliases: `muse-spark`, `spark`, `spark-1.2` → 1.2; `spark-contributor` → contributor.

## Effort

`reasoning_effort`: `minimal` | `low` | `medium` (default) | `high` | `xhigh`.

`none` is rejected by muse-spark models. Reasoning tokens count against
`max_completion_tokens`, so give the model enough output budget.

## Rate limits (headers)

Captured from `x-ratelimit-*` on every turn:

- Standard SKUs: **3000 RPM** · **4M TPM** (observed)
- Contributor: **60 RPM** · **2.1M TPM** (dashboard)

## Surfaces

| Surface | Status |
| --- | --- |
| `openai-chat-completions` | **v1** (this plugin) |
| `openai-responses` | Live on Meta (`POST /v1/responses`); adapter TBD |
| `anthropic-messages` | Live on Meta (`POST /v1/messages`); adapter TBD |

## Architecture

| Host seam | Implementation |
| --- | --- |
| `provider.json` | `id: meta`, export `metaProviderPlugin` |
| `apiKeyAuth` | `meta-api-key` → Bearer on `api.meta.ai` |
| `listLiveModels` | `GET /v1/models` |
| `fetchSessionInfo` / `primeSessionInfo` | `x-ratelimit-*` windows (`req` / `tok`) |
| Surfaces | `openai-chat-completions` |

Research corpus (private): `private/MA-49282-meta-provider/` in the monorepo.
