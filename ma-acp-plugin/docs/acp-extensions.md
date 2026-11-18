# ACP extension contract: minimal-agent and Agent Studio

Status: canonical. Date: 2026-11-04. Contract version: 1.

This file is the one source of truth for how minimal-agent (ACP agent) and Agent Studio (ACP client) use ACP and the extensions on top of it. The Studio copy at `minimal-agent-studio/docs/acp-extensions.md` is only a pointer to this file.

Goal: follow ACP as closely as possible. Add our own features so that they never break a plain ACP peer. Studio with a plain agent, and minimal-agent with a plain client, must still work, only without the extra features.

## Abbreviations and sources

Code (all paths relative to the monorepo root):

- `P/` = `minimal-agent-plugins/ma-acp-plugin/`
- `S/` = `minimal-agent-studio/`
- `C/` = `minimal-agent-cli/`
- `K/` = `minimal-agent-core/`
- `SDK/` = `S/node_modules/@agentclientprotocol/sdk/` (version 2.2.0, `S/package.json:18`)

Spec, all pinned at commit `734309dc6ff8f5a3b93adca62826dd63cff85a26` of https://github.com/agentclientprotocol/agent-client-protocol:

- EXT = https://github.com/agentclientprotocol/agent-client-protocol/blob/734309dc6ff8f5a3b93adca62826dd63cff85a26/docs/protocol/v1/extensibility.mdx
- S1 = https://github.com/agentclientprotocol/agent-client-protocol/blob/734309dc6ff8f5a3b93adca62826dd63cff85a26/schema/v1/schema.json
- S1U = https://github.com/agentclientprotocol/agent-client-protocol/blob/734309dc6ff8f5a3b93adca62826dd63cff85a26/schema/v1/schema.unstable.json
- RFD-TU = https://github.com/agentclientprotocol/agent-client-protocol/blob/734309dc6ff8f5a3b93adca62826dd63cff85a26/docs/rfds/end-turn-token-usage.mdx
- RFD-SP = https://github.com/agentclientprotocol/agent-client-protocol/blob/734309dc6ff8f5a3b93adca62826dd63cff85a26/docs/rfds/client-system-prompt.mdx
- MCP-META = https://modelcontextprotocol.io/specification/2026-07-28/basic/index (the `_meta` key name format that EXT tells us to follow)

## 1. Three layers

| Layer | What                                                                                          | When used                                                                                                                                                                                   | Rule                                                                                                                                                                                                |
| ----- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1    | Stable ACP v1 (S1)                                                                            | Always                                                                                                                                                                                      | Both sides implement it as the spec says. No `_meta` needed.                                                                                                                                        |
| L2    | Unstable ACP v1 (S1U), for example `systemPrompt` on `session/new` and `PromptResponse.usage` | Only when the peer advertises the matching standard capability. A field with no capability (such as `PromptResponse.usage`) is "best effort": send it, and the reader treats it as optional | Each L2 use has a written fallback (section 5). An L2 field can change or go away (S1U descriptions start with `**UNSTABLE**`, for example `SDK/dist/v1/unstable/schema/types.gen.d.ts:2695-2697`). |
| L3    | Our extension namespace `minimal-agent`                                                       | Only when BOTH sides advertise it and the feature is in the effective set (section 2)                                                                                                       | Data in `_meta` keys, methods with a `_` prefix. Never needed for a turn to work.                                                                                                                   |

Order of preference: L1, then L2, then L3. Use L3 only when L1 and L2 cannot express the need, or when an L2 field is ambiguous (see the usage row).

## 2. Negotiation

### 2.1 Where to advertise

EXT, section "Advertising custom capabilities": "Implementations **SHOULD** use the `_meta` field in capability objects to advertise support for extensions and their methods." The EXT example puts the keys in `agentCapabilities._meta` of the `initialize` result.

The SDK 2.2.0 types have `_meta` on all four candidate objects:

- `InitializeRequest._meta` (`SDK/dist/v1/schema/types.gen.d.ts:2917`)
- `ClientCapabilities._meta` (`SDK/dist/v1/schema/types.gen.d.ts:2967`)
- `InitializeResponse._meta` (`SDK/dist/v1/schema/types.gen.d.ts:1381`)
- `AgentCapabilities._meta` (`SDK/dist/v1/schema/types.gen.d.ts:1428`)

Decision: use the capability objects, as EXT recommends.

- Client (Studio) sends `initialize.params.clientCapabilities._meta["minimal-agent/ext"]`.
- Agent (minimal-agent) returns `initialize.result.agentCapabilities._meta["minimal-agent/ext"]`.
- Do not use the request or response root `_meta` for this.

### 2.2 Value

```json
{
  "minimal-agent/ext": {
    "version": 1,
    "features": ["usage"]
  }
}
```

- `version`: positive integer. The contract version the side implements. Current: `1`.
- `features`: array of strings. The L3 features the side implements now. A side lists a feature only when its code for that feature is shipped.

### 2.3 Effective features

1. Read the peer value. If it is absent, not an object, `version` is not a positive integer, or `features` is not an array of strings, the peer has no L3. Effective set is empty.
2. Effective version = the smaller of the two `version` values.
3. If this side cannot speak the effective version, effective set is empty.
4. Effective features = the intersection of the two `features` lists, minus any name not defined for the effective version.
5. Compute once, at `initialize`. The set does not change for the life of the connection.

Version rules:

- Add a new feature: add a name to this file. No version change.
- Change the wire shape or meaning of an existing feature in a way an old peer cannot read: make a new version and record it here.
- A side that implements version N also implements every older version it still lists here. Today only version 1 exists.

Both sides use the same algorithm. Each side has a small pure helper for it (patches E1 and E2 in `S/research/acp-controls-plan.md`). Both helpers run the same test vectors (section 7.4).

### 2.4 Plain peers

- A plain agent ignores `clientCapabilities._meta` (EXT: "MUST NOT make assumptions about values at these keys", repeated on every `_meta` type, for example `SDK/dist/v1/schema/types.gen.d.ts:2961-2969`). So Studio can always send it.
- A plain client ignores `agentCapabilities._meta` for the same reason. So minimal-agent can always send it.
- With no L3 on the other side, each side uses only L1 and L2.

## 3. Naming rules

- `_meta` keys: `minimal-agent/<feature>`, for example `minimal-agent/usage`. This matches the MCP-META key format that EXT points to: a prefix of dot-separated labels followed by `/`, then a name. MCP-META says "Implementations SHOULD use reverse DNS notation". We keep `minimal-agent/` because the plugin already ships keys with it (`minimal-agent/truncated`, `minimal-agent/totalBytes`, `minimal-agent/stopReason`, `minimal-agent/reason`, see `P/encoder.ts:271-278`, `P/stop-reason.ts:40-42`). The prefix is not reserved by MCP (MCP reserves only prefixes whose second label is `modelcontextprotocol` or `mcp`).
- Extension methods and notifications: `_minimal-agent/<name>`. EXT reserves every method name that starts with `_` for extensions. No extension method is defined in version 1.
- Never use the reserved root keys `traceparent`, `tracestate`, `baggage` (EXT, section "The `_meta` field").
- Never add custom fields at the root of a spec type. EXT: "Implementations **MUST NOT** add any custom fields at the root of a type that's part of the specification." All our data goes inside `_meta`.

## 4. Hard rules

1. Detect by capability, never by name. Do not branch on `agentInfo.name` or `clientInfo.name`. Use the standard capability (L2) or the effective feature set (L3).
2. Never change the meaning of a standard field. Fill standard fields only with the meaning the spec gives them. Where the spec meaning is unclear, fill the field best effort and put the exact meaning in an L3 key.
3. An unknown or missing extension never fails a turn. A missing L3 key means "feature not used for this turn". Use the fallback.
4. Unknown `_meta` keys are ignored. A reader reads only the keys it knows. A malformed value of a known key is treated as absent and logged at debug level.
5. Send L3 data only when the feature is in the effective set. Exception: the keys that the plugin already ships today (`P/encoder.ts:271-278`, `P/stop-reason.ts:40-42`) stay unconditional, because a plain client ignores them.
6. Extension methods. A caller sends `_minimal-agent/<name>` only when the matching feature is in the effective set. If the peer still answers `-32601` (method not found, EXT section "Custom requests"), the caller removes that feature from its effective set for the rest of the connection, logs a warning, and uses the fallback. It does not fail the turn. A receiver that does not know an extension request answers `-32601`, and ignores an unknown extension notification (EXT: "implementations **SHOULD** ignore unrecognized notifications"). Both sides already do this: the plugin at `P/transport.ts:198-213`, the SDK at `SDK/dist/core/jsonrpc.js:645-650` (only requests get the error).
7. Advertise only what the runtime can apply. The agent lists an L3 feature, or an L2 capability such as `sessionCapabilities.systemPrompt`, only when its runtime really applies it in this process. minimal-agent reads `ctx.runtime.capabilities` (set by the CLI from feature detection on the core in use, `C/src/startup/run-host-mode.ts` `detectHostRuntimeCapabilities`). No object (an older CLI): every flag is false. A `session/new` that sends `systemPrompt` when it was not advertised is -32602, never a silent drop.

## 5. Feature table

Status: "now" = planned in the current waves of `S/research/acp-controls-plan.md`. "later" = wave D.

| #   | Feature                      | Layer              | Capability key                                                              | Wire shape                                                                                                                                                                               | Fallback without it                                                           | Owner                                                      | Status                                                                                                                                                                                                                                                      |
| --- | ---------------------------- | ------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a1  | usage: per-turn token totals | L3                 | feature `usage`                                                             | `PromptResponse._meta["minimal-agent/usage"]`, see 5.a                                                                                                                                   | Read standard `PromptResponse.usage` as per-turn. If absent: no token totals  | Agent sends, Studio reads                                  | now                                                                                                                                                                                                                                                         |
| a2  | usage: standard field        | L2 (no capability) | none                                                                        | `PromptResponse.usage {totalTokens, inputTokens, outputTokens, thoughtTokens?, cachedReadTokens?, cachedWriteTokens?}` (`SDK/dist/v1/unstable/schema/types.gen.d.ts:2703`, `:2730-2754`) | Field absent: no token totals                                                 | Agent sends best effort (always, also with a plain client) | now                                                                                                                                                                                                                                                         |
| a3  | context gauge                | L1                 | none                                                                        | `session/update` `usage_update {used, size, cost?}` (`SDK/dist/v1/schema/types.gen.d.ts:2715-2727`)                                                                                      | No gauge                                                                      | Agent sends, Studio reads                                  | agent: done (`P/encoder.ts:292-304`). Studio: now                                                                                                                                                                                                           |
| b   | model                        | L1                 | `configOptions` entry with `category: "model"`                              | `session/set_config_option {sessionId, configId, value}`                                                                                                                                 | Agent default model                                                           | Both                                                       | agent: done (`P/config-options.ts:73`). Studio: now                                                                                                                                                                                                         |
| c   | effort                       | L1                 | `configOptions` entry with `category: "thought_level"`                      | same method                                                                                                                                                                              | Agent default effort                                                          | Both                                                       | agent: done (`P/config-options.ts:169-188`). Studio: now                                                                                                                                                                                                    |
| d   | systemPrompt                 | L2                 | `agentCapabilities.sessionCapabilities.systemPrompt` (and `.mode.override`) | `session/new {..., systemPrompt: {mode, content}}`                                                                                                                                       | Instructions in the first prompt text                                         | Both                                                       | now                                                                                                                                                                                                                                                         |
| e   | structuredOutput             | L3                 | feature `structuredOutput`                                                  | request `_meta["minimal-agent/outputSchema"]`, reply `_meta["minimal-agent/output"]`, see 5.e                                                                                            | Studio asks for JSON in the prompt text and parses the reply text best effort | Both                                                       | agent: done (patch D2, `P/structured-output.ts`, `P/host-mode.ts`). Advertised only when the runtime reports `capabilities.outputSchema` (core D1). The pinned core 82ff7e8 has no D1, so the feature is not advertised there (rule 4.7). Studio: done (D3) |
| f   | temperature                  | L3                 | feature `sampling`                                                          | request `_meta["minimal-agent/sampling"] {temperature}`, see 5.f                                                                                                                         | Agent default sampling                                                        | Both                                                       | agent: done (patch D5, `P/host-mode.ts`). Advertised only when the runtime reports `capabilities.temperature` (core D4). The pinned core 82ff7e8 has no D4, so the feature is not advertised there (rule 4.7). Studio: done (D6)                            |
| g   | notices                      | L1                 | client `clientCapabilities.session.notices: {}`                             | `session/update` `notice {severity, title, description?}`                                                                                                                                | Agent sends the notice as `agent_message_chunk` text                          | Agent sends. Studio does not advertise it today            | agent: done. Studio: later                                                                                                                                                                                                                                  |

### 5.a usage

Two different things. Never mix them.

1. Token totals (spent tokens per turn). Feed run stats and turn rows.
2. Context gauge (`usage_update`). `used` is "Tokens currently in context" and `size` is "Total context window size in tokens" (`SDK/dist/v1/schema/types.gen.d.ts:2716-2723`). It is a gauge. Keep the last value. Never add it to token totals. `cost` is "Cumulative session cost" (`:2724-2727`, `Cost.amount` at `:2692-2695`).

Why an L3 key: the standard `PromptResponse.usage` meaning is ambiguous.

- SDK 2.2.0 says "Token usage for this turn" on the field (`SDK/dist/v1/unstable/schema/types.gen.d.ts:2699`) and "Token usage information for a prompt turn" on the type (`:2726`).
- But the fields of the same `Usage` type say "Sum of all token types across session" (`:2732`), "Total input tokens across all turns" (`:2736`), "Total output tokens across all turns" (`:2740`).
- RFD-TU is in Draft and lists "Per-turn vs cumulative" as open question 1.

`PromptResponse._meta["minimal-agent/usage"]` shape (all integers >= 0):

```json
{
  "inputTokens": 1200,
  "outputTokens": 340,
  "cacheReadTokens": 41000,
  "cacheWriteTokens": 900,
  "thoughtTokens": 120,
  "cost": { "amount": 0.0123, "currency": "USD" }
}
```

Exact meaning:

- Scope: exactly this one `session/prompt` turn, summed over every model request in the turn. Never cumulative over the session.
- `inputTokens`: uncached input tokens. Cache tokens are NOT inside it.
- `cacheReadTokens`: input tokens read from the provider prompt cache.
- `cacheWriteTokens`: input tokens written to the provider prompt cache.
- Full prompt size of the turn = `inputTokens + cacheReadTokens + cacheWriteTokens`.
- `outputTokens`: all output tokens, reasoning included.
- `thoughtTokens`: the reasoning part of `outputTokens`, when the provider reports it. Omit when unknown.
- `cost`: the cost of this turn. `currency` is an ISO 4217 code or another unit, as in the standard `Cost` (`SDK/dist/v1/schema/types.gen.d.ts:2696-2700`). Omit when unknown.
- `inputTokens` and `outputTokens` are required. The rest are optional. Omitted means "not reported", not zero.
- Sent on every reply that has a `stopReason` (also `cancelled`), with what was counted up to that point.

What minimal-agent can fill today: core usage has `inputTokens`, `outputTokens`, `cacheReadTokens?`, `cacheCreationTokens?` (`K/src/sdk/events.ts:74-79`) and no cost (`K/src/sdk/wire-events.ts:123`). So `thoughtTokens` and `cost` are omitted for now. Core emits `turn_completed` per model round (`K/src/sdk/agent-core.ts:467-474`), so the plugin sums per prompt.

The standard field, filled best effort by the agent from the same counters:

- `inputTokens` = `inputTokens + cacheReadTokens + cacheWriteTokens` of the turn (full prompt size)
- `outputTokens`, `thoughtTokens`, `cachedReadTokens`, `cachedWriteTokens` = the same per-turn values
- `totalTokens` = `inputTokens + outputTokens` of the standard field

Studio reading order for token totals:

1. `_meta["minimal-agent/usage"]`, when `usage` is in the effective set and the key is valid. Studio input = `inputTokens + cacheReadTokens + cacheWriteTokens`.
2. Else standard `PromptResponse.usage`, read as per-turn (today's behavior, `S/server/runtime/drivers/acp/driver.ts:277-278`).
3. Else no token totals for the turn.

Risk of step 2: a plain agent that fills `usage` cumulatively is counted again on every turn. Unverified: no plain agent was checked for this.

### 5.b model and 5.c effort

Stable `configOptions` (S1). Match the option by `category`, never by option id. minimal-agent uses ids `provider`, `model`, and `effort` (`P/config-options.ts:73`), but other agents may not. No extension is needed. The `provider` option has the custom category `_provider` (one row per provider and credential, value `<providerId>` or `<providerId>:c-<10 hex>`, the credential name only in the label). It is sent only when the CLI has `listTargets`, `getTarget`, and `setTarget`.

### 5.d systemPrompt

- Studio sends `systemPrompt {mode: "append" | "override", content: ContentBlock[]}` on `session/new` only when `agentCapabilities.sessionCapabilities.systemPrompt` is present, and `override` only when `.mode.override` is present (`SDK/dist/v1/unstable/schema/types.gen.d.ts:1625-1636`, S1U, RFD-SP). Else Studio puts the instructions in the first prompt text (today's behavior).
- minimal-agent advertises the capability only when the CLI's core applies it (rule 4.7). With append and override: `{mode: {override: {}}}`. Append only: `{}`. Neither (the pinned core 82ff7e8): no capability, and `systemPrompt` on `session/new` is -32602.
- Studio mode `override` fallback: override without `mode.override`: warn and use append. No capability: warn and use the first prompt text.
- minimal-agent `override` replaces only the instructions section of the system prompt, not the full prompt. Reason: a `full` replace skips the provider hook (`K/src/llm/system-prompt.ts:147-158`), and that drops the Anthropic plan-OAuth billing block and identity (`minimal-agent-plugins/ma-llm-anthropic-plugin/system-prompt.ts:6-19`). An `instructions` replace keeps identity, provider preamble and session context (`K/src/llm/instructions-block.ts:127-138`). Details: `S/research/acp-controls-plan.md` section 4.2.

### 5.e structuredOutput

- Request: `session/prompt` `_meta["minimal-agent/outputSchema"]` = a JSON Schema object. Send only when `structuredOutput` is in the effective set.
- Agent: passes the schema to core as the `outputSchema` run option (core D1, armed per run by the CLI `hostSessionRun`), so the provider request has it on every round of the run. The agent validates the final text (the subset in `P/structured-output.ts`, nesting capped at 64 levels), retries a bounded number of times (default 2) in the same `session/prompt`, and returns the parsed value in `PromptResponse._meta["minimal-agent/output"]`.
- On retry, each attempt streams with its own messageId. Attempt 1 keeps core's id. Attempt n > 1 uses `<id>-attempt-<n>`. A client that uses structured output must read `minimal-agent/output`, not the joined text.
- Failure after retries: reply `stopReason` as normal, no `minimal-agent/output` key, and `_meta["minimal-agent/outputError"] {message}`. The turn does not fail on the wire. Studio decides.
- A retry is a new `run` call, so the CLI runs the `turn.willStart` hook chain again on the corrective prompt. If a retry run fails (for example a blocking hook) or pauses, the reply has the `stopReason` of the first run and `_meta["minimal-agent/outputError"] {message: "retry <n> failed: <reason>"}`. A throw in the schema check also gives `outputError`, never a JSON-RPC error.
- Fallback: Studio adds the schema to the prompt text and parses the reply text best effort.

### 5.f temperature

Status: agent done (D5), Studio done (D6). Core D4 adds a per-run `temperature` option, and the CLI arms it per run. The plugin advertises `sampling` only when the runtime reports `capabilities.temperature` (not with the pinned core 82ff7e8). The text below is the feasibility check from before D4, kept for the record.

Feasibility check (grep of `K/src`, `K/plugin-api/src`, the anthropic and openai provider plugins, `C/src`):

- The transport layer carries it: `SendOptions.temperature` (`K/src/llm/transport/types.ts:136`) maps to `generation.temperature` (`K/src/llm/adapter-legacy.ts:479`), typed at `K/plugin-api/src/llm/canonical-request.ts:47-48`.
- Providers send it only when the model accepts it: Anthropic `K/plugin-api/src/llm/anthropic-request.ts:448-449`, OpenAI chat `minimal-agent-plugins/ma-llm-openai-plugin/chat/request-body.ts:126-127`. The validators reject it for models with `acceptsTemperature: false` (`K/plugin-api/src/llm/anthropic-request.ts:563-567`, `minimal-agent-plugins/ma-llm-openai-plugin/validate.ts:30-32`). Many models have `acceptsTemperature: false` (for example `minimal-agent-plugins/ma-llm-anthropic-plugin/capabilities.ts:110`, `minimal-agent-plugins/ma-llm-openai-plugin/capabilities.ts:120`). The OpenAI responses body builder has no temperature at all (`minimal-agent-plugins/ma-llm-openai-plugin/responses/request-body.ts`, grep: only `maxOutputTokens` at `:250`).
- Before D4, no session code set it. `AgentCore` builds send options at `K/src/sdk/agent-core.ts:524-545` with no `temperature`. `C/src` has zero `temperature` hits. `HostRuntime` has no setter (`K/src/host-public/host-mode.ts:114-125`).

Verdict: planned as an L3 extension (user decision, 2026-11-04). ACP has no temperature field, and that is acceptable for our own pair. Core change needed first (patch D4): a per-session (or per-run) `temperature` on `AgentCore` passed into the send options at `K/src/sdk/agent-core.ts:524-545`, plus a `HostRuntime` setter or a `HostSession.run` option, plus a model check that uses `acceptsTemperature`.

Wire shape: `session/prompt` `_meta["minimal-agent/sampling"] = {"temperature": 0.2}`. If the current model does not accept temperature, the agent ignores the value and sends a `notice` (or its text fallback). It never fails the turn. Standard alternative: an agent-defined config option with a `_`-prefixed category (S1, SPEC note in `S/research/acp-spec-controls.md` section 3). We do not use it, because the value is a number, and config options are only `select` and `boolean`.

### 5.g notices

- Stable `notice` update, gated by client capability `clientCapabilities.session.notices` (`SDK/dist/v1/schema/types.gen.d.ts:3013-3018`: "Supplying `{}` means the client can present notices to the user").
- minimal-agent checks it at `initialize` (`P/host-mode.ts:161`, `P/notices.ts:125-129`) and sends `notice` or an `agent_message_chunk` text fallback (`P/notices.ts:108-121`).
- Studio does not advertise it (`S/server/runtime/drivers/acp/driver.ts:135`). So notices reach Studio as answer text. Studio advertising `notices` is "later" and needs a Studio handler first.
- Session diagnostics: most `ch: "diag"` entries are for logs and are dropped. The codes listed in `P/diag-notices.ts` become a `warning` notice, at most one time per connection for each code and sub-key. Today this is `cache.anomaly` from the `cache` plugin (sub-key: the anomaly `code`, for example `markers_ignored_cold`). The description is the diagnostic message. To show a new diagnostic, add one row to `DIAG_NOTICES`.

## 6. Who sends what

Studio `initialize`:

```json
{
  "protocolVersion": 1,
  "clientCapabilities": {
    "fs": { "readTextFile": true, "writeTextFile": true },
    "terminal": false,
    "_meta": { "minimal-agent/ext": { "version": 1, "features": ["usage"] } }
  },
  "clientInfo": { "name": "...", "version": "..." }
}
```

minimal-agent `initialize` result (after patches E1, M4, D2 and D5), on a CLI whose core supports M2/M3, D1 and D4 (rule 4.7):

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": false,
    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": false },
    "sessionCapabilities": { "systemPrompt": { "mode": { "override": {} } } },
    "_meta": {
      "minimal-agent/ext": { "version": 1, "features": ["usage", "structuredOutput", "sampling"] }
    }
  },
  "agentInfo": { "name": "minimal-agent", "version": "0.1.0" },
  "authMethods": []
}
```

On a CLI with the pinned core 82ff7e8 (no M2 append, no D1/D4 setters), there is no `sessionCapabilities` key and `features` is `["usage"]`.

## 7. Compatibility test matrix

### 7.1 Studio x plain agent (mock)

Fixture: `S/tests/fixtures/mock-acp-agent.ts`. It sends no `_meta`, no `configOptions`, and `usage {11, 7, 18}` (`:62`, `:171`). Test file: `S/tests/acp.test.ts`.

Must prove:

- Studio sends `clientCapabilities._meta["minimal-agent/ext"]` and the turn still works.
- Effective set is empty. No L3 key is read or sent. No `_minimal-agent/*` call.
- Token totals come from standard `usage` (11 in, 7 out).
- No `configOptions`: model and effort log a warning and the run goes on.
- No `systemPrompt` capability: instructions are in the first prompt.
- With an env switch, the mock advertises `minimal-agent/ext` with a malformed value: Studio treats it as absent.

### 7.2 Studio x minimal-agent

Two levels: Studio tests that spawn the plugin fixture `P/__fixtures__/host-mode-process.ts` (real `host-mode.ts`, fake runtime from `P/__fixtures__/fake-runtime.ts:88`), and the live check L1 in `S/research/acp-controls-plan.md` section 7. Assumed: the fixture imports `@minimal-agent/core/host-kit/host-mode` (`P/__fixtures__/host-mode-process.ts:15`), so Studio must spawn it with `cwd` = `P/` for module resolution. Check this when the test is written.

Must prove:

- Effective set = `["usage"]`.
- Token totals come from `minimal-agent/usage`, not from the standard field, and equal the per-turn sum.
- `usage_update` drives the gauge and is not added to totals.
- Model and effort are set with `set_config_option` before the first prompt.
- `systemPrompt` is sent and the first prompt has no instructions.

### 7.3 Plain client x minimal-agent

The plugin has zero runtime deps (`P/package.json`, no `dependencies`), so the plain client lives in the plugin tests as raw JSON-RPC:

- In process: `P/__fixtures__/in-memory-host.ts` (real handler, fake runtime). Send an `initialize` with NO `_meta`.
- Out of process: a tiny script that uses `@agentclientprotocol/sdk` (Studio already has it) and spawns `P/__fixtures__/host-mode-process.ts`. It uses only stable SDK calls and never reads `_meta`.

Must prove:

- `initialize` succeeds. `agentCapabilities._meta["minimal-agent/ext"]` is present and harmless.
- Effective set is empty. `PromptResponse` has no `minimal-agent/usage` key, but has the standard `usage` (best effort).
- A prompt with an unknown `_meta` key (for example `"com.example/x": 1`) runs normally.
- `notice` falls back to text (no `session.notices`).
- An unknown `_x/y` request gets `-32601`. An unknown `_x/y` notification gets no reply and the connection stays up.

### 7.4 Shared negotiation vectors

Both helpers (E1 in the plugin, E2 in Studio) run the same table:

| Local        | Peer                           | Effective                       |
| ------------ | ------------------------------ | ------------------------------- |
| v1 `[usage]` | absent                         | `[]`                            |
| v1 `[usage]` | `"yes"` (not an object)        | `[]`                            |
| v1 `[usage]` | v0 `[usage]`                   | `[]`                            |
| v1 `[usage]` | v1 `[usage, structuredOutput]` | `[usage]`                       |
| v1 `[usage]` | v2 `[usage, newThing]`         | `[usage]` (effective version 1) |
| v1 `[usage]` | v1 `[1, "usage"]` (bad item)   | `[]`                            |
