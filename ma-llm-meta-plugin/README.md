# ma-llm-meta-plugin

First-class **Meta Model API** (Muse Spark) provider for
[minimal-agent](https://github.com/gastonmorixe/minimal-agent-core).

OpenAI-compatible Chat Completions against `https://api.meta.ai/v1`. API-key
auth only in v1 (no Facebook/Meta OAuth). Do **not** use the retired Llama API
(`api.llama.com` / `LLAMA_API_KEY`).

## Quick start

1. Create a key at [dev.meta.ai](https://dev.meta.ai/) (US preview; payment method required).
2. Login:

```bash
minimal-agent provider meta login
# paste LLM_… key
```

Or store via the host auth flow and export for priming:

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
| `muse-spark-1.2` (default) | 1M | $1.25 / $0.15 / $4.25 | Flagship coding / agentic |
| `muse-spark-1.1` | 1M | $1.25 / $0.15 / $4.25 | Multimodal (image + PDF) |
| `muse-spark-1.2-contributor` | 1M | $0.10 / $0.002 / $0.20 | Cheap; **trains on your data**; 60 RPM |

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
