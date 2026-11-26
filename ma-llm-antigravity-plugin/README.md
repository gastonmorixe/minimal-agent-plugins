# ma-llm-antigravity-plugin

LLM provider plugin for **Google Antigravity**: the Cloud Code Assist backend
that the `agy` CLI uses (`daily-cloudcode-pa.googleapis.com`). It serves the
Gemini 4 family, Gemini 3.x flash, Claude Opus and Sonnet 5.5 (Vertex) and
GPT-OSS 120B of a Google AI plan.

Zero telemetry. The plugin does not call `play.googleapis.com/log`, the
remote config endpoint (`fetchConfig`), the trajectory analytics
(`recordTrajectoryAnalytics`) or the access-control writer
(`writeTrajectoryAcls`). "Endpoints used" below lists every call it makes.

## Login

```bash
bun run start login antigravity
```

The command opens the browser. Pick the Google account of the plan. The local
callback page says the sign-in is complete, and the token is stored in
`~/.minimal-agent/auth.jsonc` under `antigravity-oauth`. There is no code to
copy and no code to type.

The plugin uses the same OAuth client, the same 7 scopes, the same PKCE
loopback flow and the same refresh grant as `agy`. An abandoned login closes
its local callback server after 5 minutes.

Refresh, in two places:

1. Before each turn, the adapter refreshes an access token that is 60 s or
   less from expiry (`refreshIfExpiring` in `adapter.ts`). It calls the
   refresh callback that the host builds from `refreshCredential`, so the new
   token is written to `auth.jsonc`.
2. After a 401, the host refreshes and retries the request one time.

Google sends no new refresh token on a refresh, so the plugin keeps the old
one. An expired access token does not make the credential unusable: the
refresh token renews it, and `auth-status` shows the expiry time.

The plugin has no import of the `agy` token file into the store. Only the
live test reads that file (see "Test").

## Models

One row for each base model. The effort selects the `agy` model id: effort
`high` on `gemini-4-neon` sends `model: "gemini-4-neon-high"` with
`thinkingLevel: "HIGH"`, the same pair that `agy` sends.

Family rows, in catalog order:

| Base id             | Efforts                  | Default effort | Context | Output |
| ------------------- | ------------------------ | -------------- | ------: | -----: |
| `gemini-4-neon`     | low, medium, high, xhigh | high           | 1048576 | 262144 |
| `gemini-3.8-flash`  | low, medium, high        | medium         | 1048576 |  65536 |
| `claude-opus-5-5`   | low, medium, high        | medium         | 1000000 | 128000 |
| `gemini-4-carbon`   | low, medium, high        | medium         | 1048576 | 262144 |
| `gemini-4-hydrogen` | low, medium, high, xhigh | medium         | 1048576 | 262144 |
| `claude-sonnet-5-5` | low, medium, high        | medium         | 1000000 | 128000 |
| `gemini-4-argon`    | low, medium, high        | medium         | 1048576 |  65536 |

The default effort of `gemini-4-neon` is `high` because the backend default
agent model is `gemini-4-neon-high`. The other families default to `medium`.

Rows with one fixed effort, and no choice:

| Id                               | Effort | Context | Output |
| -------------------------------- | ------ | ------: | -----: |
| `gpt-oss-120b-medium`            | medium |  131072 |  32768 |
| `gemini-4-hydrogen-tiered-high`  | high   | 1048576 | 262144 |
| `gemini-4-hydrogen-tiered-xhigh` | xhigh  | 1048576 | 262144 |

Every other id is a single row with no effort picker: the flash-lite ids,
`gemini-2.5-flash`, `gemini-2.5-flash-thinking`, `gemini-3-flash`,
`gemini-3.1-flash-image`, `gemini-3.8-flash-tiered`,
`gemini-4-hydrogen-sonar`, `gemini-flash-worker-agy` and the
`gemini-pro-orchestrator*` ids.

```bash
bun run start --provider antigravity --model gemini-4-neon --effort low -p "hi"
bun run start --provider antigravity --model claude-sonnet-5-5 --effort low -p "hi"
```

The groups come from `groupedModels` of `v1internal:fetchAvailableModels`.
An id with a level suffix and no group has that one level as a fixed effort.
An old suffixed id such as `gemini-4-neon-high` still resolves, to
the base model plus that effort, so a saved session keeps working. The static
catalog is a snapshot from 2026-11-25. The live list is fetched at startup
with a 60 s cache, so a new model works without a release.

## Wire details that differ from the public Gemini API

1. `functionResponse` parts travel in a content with role `user`. The `agy`
   client uses role `model`, but the backend accepts `user` for every family,
   and the canonical tool result maps to it with no special case.
2. `thoughtSignature` is a sibling key of `functionCall` in the same part, not
   a field inside it. A Gemini model rejects a tool loop when the latest
   assistant `functionCall` has no signature, so the plugin keeps a tool-id to
   signature cache and echoes each value byte for byte. A signature the plugin
   does not have is omitted, never guessed: a wrong value is a 400.
3. Claude and GPT-OSS send no signature at all. GPT-OSS takes
   `thinkingBudget` (a number); every other family takes `thinkingLevel` (a
   string).
4. Tool schemas use upper-case JSON Schema types (`OBJECT`, `STRING`).

## Endpoints used

| Purpose                                   | URL                                                 |
| ----------------------------------------- | --------------------------------------------------- |
| Code exchange and token refresh           | `POST https://oauth2.googleapis.com/token`          |
| Account email (login, `auth-status plan`) | `GET https://www.googleapis.com/oauth2/v2/userinfo` |
| Tier and project id                       | `POST /v1internal:loadCodeAssist`                   |
| Model catalog                             | `POST /v1internal:fetchAvailableModels`             |
| Quota (status bar, `auth-status plan`)    | `POST /v1internal:retrieveUserQuotaSummary`         |
| Inference (SSE)                           | `POST /v1internal:streamGenerateContent?alt=sse`    |

The `/v1internal:` paths are on `https://daily-cloudcode-pa.googleapis.com`.
The plugin contacts no other host. The browser opens
`https://accounts.google.com/o/oauth2/v2/auth` for the consent screen, and
Google redirects it to the local callback server. No call spends inference
quota except `streamGenerateContent`.

## Capabilities

1. Streaming text and thinking.
2. Tool calls with parallel calls, server ids, and the thought signature of
   the call (echoed back byte for byte, never changed).
3. Images and PDF input on the models that declare them.
4. Prompt caching is automatic and the backend reports cache hits.
5. No assistant prefill, no server-side history.
6. No structured outputs: the request body sends no JSON schema, so
   `structuredOutputs` is false and a `json_schema` request fails validation.

## Test

```bash
bun test                                # unit tests, no network
E2E=1 bun test antigravity.e2e.test.ts  # live turns
bun run check                           # the plugins gate
```

The live test reuses the `agy` OAuth login, so it needs no new consent. It
reads the `antigravity-oauth` entry of `~/.minimal-agent/auth.jsonc`
(`MINIMAL_AGENT_AUTH_FILE` changes the path). When that entry is absent, it
reads the token file of `agy` with `readAgyTokenFile`:
`~/.gemini/antigravity-cli/antigravity-oauth-token`, then
`~/.gemini/jetski-standalone-oauth-token`. It only reads that file and never
writes it: `agy` owns it. Without `E2E=1` every live case skips.

## Links

1. `provider.json`: the plugin descriptor.
2. `wire-constants.ts`: hosts, paths, OAuth client, scopes, User-Agent.
3. `adapter.ts`: the adapter and the plugin object.
