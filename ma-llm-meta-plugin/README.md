# ma-llm-meta-plugin

First-class **Meta Model API** (Muse Spark) provider for
[minimal-agent](https://github.com/gastonmorixe/minimal-agent-core).

**Responses-primary** against `https://api.meta.ai/v1/responses`, with Chat
Completions aliases for OpenAI drop-in. Supports **Muse Code OAuth** (device
code, same flow as the Muse CLI) and **Model API keys** (`LLM_…`). Do **not**
use the retired Llama API (`api.llama.com` / `LLAMA_API_KEY`).

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

3. Run with a Muse Spark model (Responses by default):

```bash
minimal-agent --provider meta --model muse-spark-1.3
# Chat Completions companion:
minimal-agent --provider meta --model muse-spark-1.3-chat
```

## Models (static catalog + live `GET /v1/models`, 2026-10-04)

`ma provider meta models` lists the **static** registry below. Live ids also
include non-text SKUs (`sam-3.1`, `muse-image-1.0`, `muse-voice-transcribe-1.0`)
that this text/agent plugin does not register.

| Id | Surface | Context | Pricing / 1M (in / cached / out) | Notes |
| --- | --- | --- | --- | --- |
| `muse-spark-1.3` (default) | Responses | 1M | $1.25 / $0.15 / $4.25 | Current flagship · multimodal |
| `muse-spark-1.3-chat` | Chat | 1M | same | Compatibility alias |
| `muse-spark-1.3-contributor` | Responses | 1M | $0.10 / $0.002 / $0.20 | Cheap; **trains on your data** |
| `muse-spark-1.3-contributor-chat` | Chat | 1M | same | Compatibility alias |
| `muse-spark-1.2` | Responses | 1M | $1.25 / $0.15 / $4.25 | Prior |
| `muse-spark-1.2-chat` | Chat | 1M | same | Compatibility alias |
| `muse-spark-1.1` | Responses | 1M | $1.25 / $0.15 / $4.25 | Balanced |
| `muse-spark-1.1-chat` | Chat | 1M | same | Compatibility alias |
| `muse-spark-1.2-contributor` | Responses | 1M | $0.10 / $0.002 / $0.20 | Prior contributor |
| `muse-spark-1.2-contributor-chat` | Chat | 1M | same | Compatibility alias |

Aliases: `muse-spark`, `spark`, `spark-1.3` → 1.3 (Responses); `spark-contributor` → 1.3-contributor (Responses).
Wire model id is always the bare Meta slug (`vendorIds.firstParty`).
Pricing: Standard/Contributor from https://dev.meta.ai/docs/pricing-rate-limits.

## Effort

Chat: `reasoning_effort`. Responses: `reasoning.effort` (+ optional
`reasoning.summary`: `auto` | `concise` | `detailed`).

| SKU | Levels |
| --- | --- |
| Standard `muse-spark-1.3` | `minimal` \| `low` \| `medium` (default) \| `high` \| `xhigh` \| `max` |
| Contributor / older Spark | `minimal` \| `low` \| `medium` (default) \| `high` \| `xhigh` |

`none` → HTTP 400 on Muse Spark. `max` is **Standard 1.3 only** (not Contributor).
Reasoning tokens count against `max_output_tokens` / `max_tokens` and billed output.
`logprobs` unsupported (400).

Audio understanding on 1.3 is currently degraded; prefer `muse-voice-transcribe-1.0`
or 1.2 for ASR (this plugin keeps `modalities.audio: false`).

## Context / encrypted reasoning replay

Default Responses mode is **stateless encrypted CoT replay**:

- `store: false`
- `include: ["reasoning.encrypted_content"]` on every Responses request
- `previous_response_id` is **not** the default (dropped unless `store === true`)
- Meta mutual exclusion: encrypted include and `previous_response_id` are never sent together

Chat Completions remains available via `*-chat` model ids for simple OpenAI drop-in without CoT continuity.

## Rate limits (headers)

Captured from `x-ratelimit-*` on every turn. Docs (team tier, 2026-10-04):

- Standard SKUs: **3000 RPM** · **4_000_000 TPM**
- Contributor: **100 RPM** · **3_000_000 TPM** (training-eligible)

## Surfaces

| Surface | Status |
| --- | --- |
| `openai-responses` | **v1 primary** (agent runs, encrypted CoT replay) |
| `openai-chat-completions` | Compatibility (`*-chat` model ids) |
| `anthropic-messages` | Live on Meta (`POST /v1/messages`); adapter TBD |

## Architecture

| Host seam | Implementation |
| --- | --- |
| `provider.json` | `id: meta`, export `metaProviderPlugin` |
| `apiKeyAuth` | `meta-api-key` → Bearer on `api.meta.ai` |
| `listLiveModels` | `GET /v1/models` |
| `fetchSessionInfo` / `primeSessionInfo` | `x-ratelimit-*` windows (`req` / `tok`) |
| Surfaces | `openai-responses` + `openai-chat-completions` |

Research corpus (private): `private/MA-49282-meta-provider/` in the monorepo.
