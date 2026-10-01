# Changelog

All notable changes to this repository. Loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Each entry is prefixed with a local-time timestamp (`HH:MM:SS ±HHMM`) and the short commit hash when one exists. Entries without a hash are working-tree changes that haven't been committed yet.

## [Unreleased]

### Added

- 2026-09-29: **OpenAI provider: GPT-6.1 Sol, GPT-6 Sol, GPT-6 Luna, Ultrafast, and
  the older models the API still serves.** Work by Fernando (`a1f4e699`).
  - New models (Responses plus `-chat` where the API allows it): `gpt-6.1-sol`
    ($2/$10), `gpt-6-sol` ($2/$10), `gpt-6-luna` ($0.10/$0.50). Data comes from the
    model cards and live probes with an API key.
  - Live effort ladders: `gpt-6.1-sol` low to max (no `none`). `gpt-6-sol` and
    `gpt-6-luna` none to max. Chat Completions: `gpt-6.1-sol` rejects function
    tools at every effort. `gpt-6-sol` and `gpt-6-luna` take tools only with
    effort `none`. The `-chat` caps flag tools off to match.
  - `service_tier: "ultrafast"` is sent only for `gpt-6-astra` on Responses. The API
    returns 400 for it on every other model. Chat drops it. `speed:"fast"` still
    maps to `priority`.
  - `ultra` effort stays in the Codex-listed ladders (`gpt-6.1-sol`, `gpt-6-astra`,
    `gpt-6-sol`, `gpt-5.6-sol`, `gpt-5.6-terra`). Both the API and the Codex wire
    rejected it on the test account (2026-09-29). It may be gated to higher plans.
  - Ids the API lists but that return 404 (removed 2026-07-23 and 2026-08-10) are
    not registered. The list is in `models.ts`.
  - Sub-agent scout pick is unchanged: `gpt-6-luna-chat` has no `fast` tag because
    its tools work only with effort `none`.

### Changed

- 2026-09-28: **Cursor models now see only minimal-agent tools.** Work by Eric
  (`9a34c325`), reviewed by Margaret (`740642b5`).
  - What changed: with MA tools on, the plugin sends
    `x-cursor-agent-allowed-tools: mcp_tool_call,get_mcp_tools_tool_call` and no
    exclude header (`eb1c76f`).
  - Why: the exclude header blocked native calls, but the server still described
    every native Cursor tool to the model, so the model listed Shell, StrReplace,
    TodoWrite and others. With the allowlist, the model lists only
    GetDynamicTools, CallDynamicTool and minimal-agent tools.
  - `get_mcp_tools_tool_call` (GetDynamicTools) is required. Without it the server
    rejects the Run with "Required tool GET_MCP_TOOLS not found in allTools".
  - Self-heal (`eb1c76f`, `3faf97a`):
    - When the server demands another tool before any output reached the host,
      the plugin learns the tool, retries the Run once with it allowed, and keeps
      it allowed for later Runs in the same process.
    - A second error, or a tool name that is not in the catalog, is shown as an
      error.
    - A leading `message_start` does not block the retry.
  - Kill switch: `MA_CURSOR_TOOL_FILTER=exclude` restores the old exclude list.
    Runs with tools off (toolChoice none) still send the exclude list.
  - Evidence:
    - Live A/B of 5 header variants:
      - The exclude list alone left the model listing 6 base and 13 "cursor"
        native names.
      - The allowlist with only `mcp_tool_call` made the server reject the Run
        (twice, with and without the exclude list).
      - The allowlist with `get_mcp_tools_tool_call` worked in 3 of 3 runs.
    - Live matrix on cursor-auto, Claude Opus 5.5, GPT 5.6 Sol, Grok 4.7 and
      Composer 2.5, in agent, ask and plan modes, with the full 42-tool MA set.
      0 "Required tool" errors, 0 unsupported execs.
    - A real TUI session with the full tool set.
  - This corrects the earlier 2026-09-28 entry "Cursor provider no longer gets
    stuck after one or two prompts". Its snake_case exclude fix (`c6c7823`)
    blocked native calls, but it did not hide native tools from the model's
    listing. The allowlist does.

- 2026-09-28: **Cursor model catalog refreshed to CLI 2026.09.28.** Work by Debra
  (`4cd8c427`) and Adrian (`9f066079`), reviewed by Margaret (`740642b5`).
  - Registry: 298 to 375 static rows, 471 registered ids. All 246 ids that the
    Cursor CLI lists now resolve (42 did not before).
  - When the server sends only one variant of a model, the plugin synthesizes the
    effort and fast SKUs. Probed live with HTTP 200: grok-4.7-low,
    gemini-3.8-flash-low, claude-sonnet-5-5-low, muse-spark-1.3-minimal.
  - Hidden and long-context models are requested and registered. They are left
    out of the live model list but are still selectable with `--model`.
  - `cursor-kimi` and `cursor-kimi-latest` now resolve to kimi-k2.7-code.
    kimi-k3 is a separate model.
  - A bare model id sends the server's default non-max SKU. grok-4.5 and
    grok-4.6 stay on medium.
  - The muse-spark `minimal` effort is recognized.
  - A CLI drift fixture and test guard the catalog. Regenerate with
    `bun run generate:static-catalog`.
  - Commits: `b6e84a3`, `e5a9bfa`, `fbed672`, `1e5e8d2`, `b9dad15`, `fbc8482`,
    `35dcac0`, `9652ec9`.
  - Known nit: a bare grok-4.7 with speed fast and no effort sends the
    `-medium-fast` SKU.

### Fixed

- 2026-10-01: **Cursor no longer writes fake tool calls as text on long
  sessions.** Work by Nancy (`f6dd2a25`).
  - Root cause: each new user prompt opened a fresh Run with an empty
    `conversation_state` and the whole transcript folded into one user text.
    In one session that text was about 500k characters with about 160 past
    tool calls. The model copied that pattern as plain text
    (`[tool_use id] Name {...}`) and ran no tool.
  - Fix: keep the server's checkpoint (`conversation_checkpoint_update` #3)
    and KV blobs from the last clean turn, and send them back on the next
    fresh Run with only the new user text, as the official CLI does. The
    state persists under `~/.minimal-agent/cursor-carry/`. Falls back to the
    fold when the transcript does not match. Kill switch `MA_CURSOR_CARRY=0`.
  - Proof: a live end-to-end test makes a real tool call and recalls an
    earlier tool result from a fresh Run.

- 2026-09-28: **Cursor requests without tools no longer hang.** Context
  compaction, titles and summaries no longer stall. Compaction is part of what
  users saw as "stuck after one or two prompts". Work by Eric (`9a34c325`),
  reviewed by Margaret (`740642b5`).
  - Root cause: a Run with no tools took the unary path. The server sends
    KvServerMessage set_blob and waits for the ack before turn_ended, and only the
    bidi wire can answer, so these turns hung until the host watchdog. In one live
    session, compaction stalled for about 8 minutes and the user had to interrupt.
  - This bug is older than this week's regression. The live e2e "cursor-auto text
    round-trip" timed out at 60 s in both baseline runs, including the one pinned
    to client version `cli-2026.07.23`.
  - Follows the earlier 2026-09-28 entry "Cursor provider no longer gets stuck
    after one or two prompts", which fixed Runs with tools.
  - Fixes:
    - `1be6890`: use the bidi wire whenever a network client exists, tools or not.
      The unary path stays as the fallback without a network client, or with
      `MA_CURSOR_BIDI=0`. mcp_state on a tool-less Run is answered with an empty
      server list. Read-loop acks are skipped when the server already closed its
      side.
    - `6a31f1d`: each tool-less Run gets a unique session key, so a compaction
      and a title call at the same time do not close each other, and neither
      closes an open tool session with a pending exec.
    - `0d07aad`: the session is cleaned up when the caller stops early (Esc, a
      watchdog, a host retry), unless a pending exec must survive for its
      continuation. Before this, each abandoned tool-less Run leaked an open h2
      wire and its heartbeat timer.
  - Evidence: the live e2e "cursor-auto text round-trip" passes in 3.4 s (it was
    a 60 s timeout), and a real `/compact` finished in about 5 s.

- 2026-09-28: **Cursor provider no longer gets stuck after one or two prompts**,
  and the model now sees and calls MA tools again. Tested against Cursor CLI
  build `2026.09.28-64d2043` wire. Work by Eric (`9a34c325`) and Margaret
  (`740642b5`). One fix per commit, and each fix has a test that failed
  before the change.

  Root cause: the Cursor server now sends
  `ExecServerMessage.mcp_state_exec_args` (#36). It asks the client for its
  MCP servers and tools before it exposes them to the model. The plugin
  dropped this frame as an unknown exec. So the server waited, the model got
  no MA tools, and it fell back to Cursor native tools. A tool-result
  continuation then sat silent until the host 120 s watchdog fired.

  Ruled out:
  - Client version stamp: `cli-2026.07.23` fails the same way as `cli-2026.09.28`.
  - Usage cap: `cursor-auto` still had quota.
  - Dead pooled h2 connection: the stalls were continuation writes on the
    open stream, not new requests.

  - `4703a05` mcp_state reply (main fix). Answer #36 with
    `mcp_state_exec_result` success: one `minimal-agent` server, status
    `connected`, our `McpToolDefinition` rows, then `stream_close`. This
    matches the official `mcp-state-executor`.
  - `c6c7823` Exclude header uses snake_case proto names (`shell_tool_call`).
    The official CLI validates and sends `ToolCall.fields[].name`. We sent
    camelCase oneof cases, which matched nothing.
  - `7c37cc7` Exclude catalog refreshed from 58 to 69 oneofs, adding 70-80
    (goals, agents, canvas, PR code tour). A drift test checks the catalog
    against a checked-in CLI snapshot.
  - `c2e4bf2` Any other exec MA cannot answer gets
    `exec_client_control throw {id, error}` then `stream_close {id}`, as the
    official CLI does when it has no handler. The log line
    `read.exec-unsupported` names the oneof.
  - `b487322` `interaction_query` (#7) is answered with a rejection
    (`interaction_response` #6) instead of being ignored.
  - `3703b97` A Run stream that ends with no content (for example the usage
    cap, HTTP 200 then an instant close) now shows an error instead of an
    empty turn.
  - `f3f4269`, `ddd2ad3` A tool-result continuation with no progress for 30 s
    closes the stream. It emits a retryable `stream_idle` error, so the host
    retries with a fresh Run at once instead of after 120 s. Any frame larger
    than a heartbeat counts as progress. Set it with
    `MA_CURSOR_BIDI_CONTINUE_IDLE_MS` (`0` turns it off).
  - `2446193` A fresh Run that rebuilds history now keeps `tool_use` and
    `tool_result` blocks, paired by id. The result is capped at 20000 chars.
    Before this, a retry lost the tool result.

  Proof:
  - Offline: `bun run check` passes (4237 pass, 0 fail).
  - Live e2e "bidi MCP tool round-trip": passes in 5.9 s. Before the fixes it
    hung for 35 s.
  - Live 3-prompt TUI session with the full tool set: 4 MA tool calls, no
    stall, no retry, no native tool calls.
  - Live forced continuation timeout: one retry after 95 ms. The retry body
    holds the tool pair, and the answer used the tool result.

  Not done, or Assumed:
  - Skipped on purpose: we still send `RequestedModel.is_variant_string_representation`
    (#8). It is gone from the 09.28 descriptor, but we have no evidence that
    the server rejects it.
  - The model still lists Cursor native tool names when asked. It did not
    call any. Next test: `x-cursor-agent-allowed-tools: mcp_tool_call`.
  - Assumed: a throw is a safe reply for housekeeping execs
    (`request_context_args`, allowlist prechecks, `git_diff`). None appeared
    live.
  - Assumed: rejection is safe for interaction kinds other than web search.
  - Assumed: `stream_close` after the mcp_state reply is correct. The server
    accepted it live.
  - Unknown: when the server began to require mcp_state. On 2026-09-25, MA
    tools still worked without it.
  - Open: the plugin files `connect/bidi-http2.ts` and `connect/bidi-stream.ts`
    are dead code (not imported). We did not remove them.
  - Open: core counts a continuation with no data as "pre-headers" for the
    full 120 s. The plugin guard works around this, and core is unchanged.

- 2026-09-15 (this session): WSL OAuth device-code polls no longer stall forever
  when a connect/fetch hangs. Cursor poll uses a 15s AbortSignal timeout.
  OpenAI, Grok, Muse, and ClinePass set `timeoutMs: 15000` on device request
  and poll. Host races `complete()` against `expiresInMs`. Prefer IPv4 DNS.

### Known issues

- Cursor debug mode (`cursor-agent-mode: debug`) fails with "The debug
  configuration was not set up properly", with either tool header. The tool
  filter does not cause it. It is not fixed.
- With the allowlist, a server-required tool that is not in the plugin catalog
  fails the Run with the raw server error and no retry. Use
  `MA_CURSOR_TOOL_FILTER=exclude` as the fallback.
- MA does not send Cursor `conversation_state` or store checkpoints. So Cursor
  server-side auto-compaction never applies to MA sessions. Cursor staff have
  said it starts at about 90% of the window (forum post, cited in the CLI
  2026.09.28 reverse-engineering report 04). We did not measure this.
  - MA compaction is host-side. Core compacts on its own only when the provider
    returns a context-length error (`src/host/context-exceeded-recovery.ts`). There
    is no percentage threshold in core.
  - With Cursor, MA's own compaction is a tool-less Cursor request. That is why
    the tool-less fix above matters for long sessions.
  - There is no per-provider switch for MA auto-compaction yet. Only the global
    `MINIMAL_AGENT_AUTO_COMPACT=0` exists.
- The allowlist and exclude behavior is verified against server behavior at CLI
  2026.09.28 only. A server change could reject the allowlist.
  `MA_CURSOR_TOOL_FILTER=exclude` is the fallback.
- The plugins CI lint step fails on a fresh install (oxlint 1.86 with
  oxlint-tsgolint 0.24, `bun.lock` is gitignored). It passes locally with oxlint
  1.73.0.

### Changed

- 2026-09-12 (this session): Grok provider aligned to official grok CLI 1.0.30
  (`04b7ffed98c6`) + grok-build 1.0.24 + docs.x.ai. Client version
  `1.0.5` → `1.0.30`. OAuth inference now sends session/conv/req/agent
  headers, `x-grok-client-mode`, and compaction headers
  (`x-compaction-at` = 80% of ctx, `x-compactions-remaining: 1`).
  Responses `reasoning.effort` accepts `xhigh`. Always send
  `reasoning.summary=concise` and `include=["reasoning.encrypted_content"]`.
  Sticky `prompt_cache_key` from session id. `--fast` / `speed:"fast"`
  maps to `reasoning_effort=low` (not `service_tier`). Dropped the
  incorrect `grok-build-latest` alias of grok-4.5. grok-4.6 cutoff
  `2026-02-01`. Server tool `web_search` uses xAI `{type:"web_search"}`
  (not OpenAI `web_search_preview`). Collab with Sebastian on grok-build.

### Added

- 2026-09-08 (this session): OpenAI GPT-6 Astra. Live Codex catalog
  (`GET chatgpt.com/backend-api/codex/models?client_version=1.0.0`,
  credential `openai-chatgpt-oauth-4`, plan plus) + public model card list
  `gpt-6-astra` as flagship (1.05M context, 128K max out, cutoff
  2026-04-30, Fast 2x). Dual-registered Responses + Chat Completions
  (`gpt-6-astra` / `astra`, `gpt-6-astra-chat` / `astra-chat`). Effort
  `low|medium|high|xhigh|max|ultra` (default `low`; no API `none`).
  Pricing $10 / $50 (cache write $12.50, cache read $1). Subagent
  flagship tags now resolve to Astra. Hidden Codex `gpt-reserve` /
  `codex-auto-review` stay unregistered.

### Changed

- 2026-09-12 (this session): Grok status bar no longer paints `rpm` / `tpm`
  quota windows. xAI `x-ratelimit-*` headers are still cached, but those bars
  sit at 0% (remaining==limit) and waste space. `week` / `month` / `ondemand`
  stay.

- 2026-09-08 (this session): GPT-5.6 Sol short-context Standard pricing
  updated to the current promo ($4 / $20, cache write $5, cache read
  $0.40; promo through at least 2026-11-21 per pricing page).

### Added

- 2026-08-31 (this session): Cursor OAuth login/refresh best-effort enrichment
  via `DashboardService/GetMe` + `GetCurrentPeriodUsage`, persisted as display-
  safe account metadata on the secret bag. `inspectCredential` projects
  `AuthCredentialInfo.details` (user id, email, plan, on-demand, usage note)
  for host `auth-status`. Probe failures never block login/refresh and never
  erase prior metadata. New `account.ts` + tests; oauth-login / auth.test
  coverage.

### Fixed

- 2026-08-31 (this session): Cursor bidi ignored mid-turn queued prompts and
  could hang forever on "Sending request" after a silent mcp_result continue
  (BUG #293802). (1) Host `drainQueuedUserText` already appended the follow-up
  as a `text` block next to `tool_result`s, but `runCursorBidi` only wrote
  `exec_client_message` on the keep-open AgentService/Run stream. Official
  Cursor Agent CLI (`2026.08.25-3e8eec8`) writes
  `AgentClientMessage.conversation_action` (`source:"queued_action"`) on
  that same stream; continuation now encodes that field-4 frame when trailing
  user text is present. (2) `readBidiUntilPauseOrEnd` reused `envelopeGen`
  bound to attempt-1's AbortSignal, so the per-attempt TTFB/idle watchdog
  could not close the keep-open wire on continue — attach the current
  `opts.signal` → `wire.close()` instead. Offline tests: `bidi-kv.test.ts`,
  `bidi-tool-results.test.ts`, `proto/client-message.test.ts`.

- 2026-08-29 (this session): Fetch/obscura-worker orphans after agent exit.
  `defaultParentExitHook` no longer installs SIGINT/SIGTERM/SIGHUP listeners
  (those disabled Node/Bun default terminate-on-signal, so a supervisor
  SIGTERM after `ReportResult` killed nothing useful and left the bun
  worker — plus its detached `obscura-worker --fetch-protocol` child —
  alive under launchd for hours). Hook now listens to `exit` only.
  Sub-agent stop / deadline / lead `agent.willStop` use SIGKILL so any
  remaining signal swallower cannot strand the fleet; forced parent death
  still reaps obscura-worker via stdin EOF. Fetch also shuts the
  persistent worker down on `agent.willStop`. Sub-agents keep `lastPid`
  across `ReportResult` finalize so `stopAllAgents` / `stopAgent` can
  SIGKILL done-but-alive leftovers (status stays terminal; pid is reaped).
  Obscura spawn still uses `detached: true` for Chromium process-group kill.

### Added

- 2026-08-18 (this session): OpenAI Fast mode. Live Codex catalog
  (`GET chatgpt.com/backend-api/codex/models`, credential
  `openai-chatgpt-oauth-3`, plan prolite) catalogs Fast as
  `service_tiers[{id:"priority", name:"Fast"}]` and
  `additional_speed_tiers: ["fast"]` on gpt-5.6-sol/terra/luna, gpt-5.5,
  and gpt-5.4 — not gpt-5.4-mini. The wire value is still `priority`.
  `speedFast` is now true on those models and their Pro/Chat siblings.
  `--fast` / `speed:"fast"` (and `serviceTier: "fast"`) map to
  `service_tier: "priority"`. gpt-5.4-mini/nano and gpt-4o stay off;
  sticky `--fast` on those models degrades instead of failing. Sol/Terra
  also advertise Codex effort `ultra` (Luna does not).

- 2026-08-18 (this session): Cursor quota-status bar now reads
  `DashboardService/GetCurrentPeriodUsage` (JSON Connect) into the same
  `month` / `ondemand` windows as Grok. Prime on boot, cache-only
  `fetchSessionInfo`, fire-and-forget refresh after each AgentService/Run.
  Enterprise fallback is `GET /auth/usage` as a `req` window when included
  cents are missing. `displayMessage` is not parsed.

### Fixed

- 2026-08-17 (this session): Cursor AgentService/Run chat no longer dies with
  Connect `not_found` / `resource_exhausted` (“Too many computers”). Root
  cause was IDE fingerprint headers (`x-cursor-checksum`, `x-client-key`,
  …), not exploded SKUs. Default headers now match Cursor Agent CLI
  (`fingerprint: "cli"`, no IDE checksum). Parameterized AvailableModels
  (`use_model_parameters=true`) dual-registers parent API names (`grok-4.6`)
  and exploded host ids; Run `RequestedModel` prefers exploded legacy SKUs
  (`cursor-grok-4.6-high`). Default agent host is
  `agentn.global.api5.cursor.sh` (GetServerConfig `agentn_url`); client
  version is `cli-*`. See
  `ma-llm-cursor-plugin/docs/agent-run-too-many-computers-postmortem.md`.

- 2026-08-17 (this session): Cursor bidi turns no longer leave the TUI on
  “Receiving stream ⋯ stalled” after text already arrived. MA now answers
  `kv_server_message` get/set-blob with `kv_client_message` and sends
  `client_heartbeat` every 5s (`MA_CURSOR_BIDI_HEARTBEAT_MS`; `0` disables).
  Skipping either left the keep-open HTTP/2 read hanging so
  `requestStatus` never cleared.

- 2026-08-14 (this session): Cursor's offline registry now includes all 207 visible
  authenticated AvailableModels parents plus their namespaced alias/legacy rows
  (236 host ids total), including non-fast Grok variants. Capabilities preserve
  the live 128K context / 16K output defaults, modality and thinking flags, and
  closed effort semantics when Cursor exposes no wire effort parameter. The
  generated catalog is sourced from the authenticated `cursor-oauth-2` probe.

- 2026-08-13 (`1f55da0`): `ma-quota-status-plugin` no longer invents a wire
  effort when none is set. The model segment still renders a bare bold
  `modelLabel` (e.g. `cur-auto`) for haiku / cursor-auto, and only suppresses
  the segment when both effort and label are absent. README and regression
  coverage match the new bare-tag path.

### Changed

- 2026-08-07 (this session): `ma-web-search-plugin` retries are now visible
  and smarter, and the model learns when retrying is worth it. Brave's retry
  backoff spreads across a few seconds (`baseDelayMs` 500→1000,
  `maxDelayMs` 5s→8s, `maxTotalMs` 15s→20s) and 429s without a
  `Retry-After` header get a 1s minimum floor, so the 3 attempts land at
  ~0s/~1s/~2s instead of re-hammering the limiter instantly. Each backoff
  emits a `retrying in ~Ns (attempt 2/3)` notice that the chain forwards to
  the per-plugin logger — retries are visible to the user, not a silent
  delay. `WebSearchProviderError` gains a `transient` flag (true for
  rate-limit/upstream/network, false for auth/validation); the chain records
  it on each failure, and when EVERY provider failed transiently the tool's
  error message now tells the model the failure was transient, that retries
  were already attempted with backoff, and to retry in a few seconds (or use
  a different query) rather than treating it as a final answer. CLI mirrors
  the same hint. Root cause from session `8c8e1d31`: 4 concurrent agents
  shared one Brave free-plan key (1 req/sec); 17 requests in a 4.4s window
  saturated the limiter, so every retry re-joined a full queue. Tests: 9 new
  (classifyError floor/header cases, onRetry notice, transient marking,
  registry propagation + forwarding, handler transient/permanent message).
  Also adds the package-local `tsdoc.json` (extending root) so oxlint
  recognizes `@module` — the web-search package lint was failing before this
  change (12 errors) and now passes.

- 2026-08-05 (this session): `ma-fetch-plugin` no longer pins an obscura build
  epoch in `setup.ts`. Setup resolves the rolling `gastonmorixe/obscura-dist`
  `latest` release at boot (sha256 from sidecar), then asks the host to
  provision/update. Falls back to `/releases/latest` if the rolling tag is
  missing, and keeps an already-installed binary when resolve fails offline.
  New `lib/resolve-obscura-release.ts` + tests. `scripts/sync-obscura-release.ts`
  is now an informational dump (no longer rewrites setup).

### Added

- 2026-08-05 (this session): `ma-llm-meta-plugin` landed. Meta Model API
  (Muse Spark) via `https://api.meta.ai/v1` OpenAI Chat Completions. API-key
  auth (`meta-api-key` / `MODEL_API_KEY`), static + live catalog
  (`muse-spark-1.2`, `1.1`, `1.2-contributor`), effort
  `minimal|low|medium|high|xhigh`, rate-limit header session info, 12 unit
  tests. Research: monorepo `private/MA-49282-meta-provider/`.
- 2026-08-05 (this session): Husky + Commitlint (Conventional Commits) —
  `commitlint.config.js`, `.husky/commit-msg`, `prepare` → `husky`, scripts
  `commitlint` / `commitlint:last`. CI `commitlint` job on push/PR.
  Agent-gated `scripts/check-agent-coauthor.sh` on `commit-msg` when
  `MINIMAL_AGENT_SESSION_ID` is set (humans unaffected).
- 2026-07-23 (this session): `ma-llm-cursor-plugin` landed as a self-contained Cursor provider on the custom `cursor-agent-run` Connect/protobuf surface. Authentication stays in the minimal-agent provider store: pasted API keys are exchanged at request time, while browser login uses Cursor's `loginDeepControl` challenge/poll flow; credentials never fall back to environment variables or macOS Keychain. Request identity includes Cursor-compatible checksum, machine/client IDs, and Connect headers with only non-secret `MA_CURSOR_*` overrides. The authenticated `AvailableModels` catalog decoder maps aliases, variants, context windows, thinking/image support, and effort levels into the live model refresher, with a namespaced offline static seed. ASK-mode streaming translates Cursor token/thinking/usage/error events into canonical events while minimal-agent retains tool ownership.
- 2026-07-15 (this session): `ma-llm-clinepass-plugin` landed. ClinePass provider (OpenAI-compatible open-weight catalog via `api.cline.bot`). API key + WorkOS device-code OAuth, 10 `cline-pass/*` models, session quota windows from rate-limit headers, package-local `tsdoc.json`. 14 unit tests.
- 2026-07-15 01:45:31 -0400 (this session): `ma-intercom-plugin` `@`-mention peer autocomplete + dual representation. Typing `@` opens a slash-menu-style fuzzy peer list (footer overlay) sorted online-first with status colors, name/short sid/pid/model/cwd. Matching `@tokens` paint live via `editor.buffer.styles` (violet/purple bold). On the model path, `turn.willStart` rewrites uniquely resolved tokens to peer XML while scrollback/queue keep the styled `@token`. Wire form in `lib/mention/PROMPTS.ts`. `resolvePeer` matches display names. Handlers: `on_key` (prio 65), `on_buffer_changed`, `on_turn_will_start`. Package-local `tsdoc.json`. 41 pure-lib tests. README section.
- 2026-07-12 22:32:03 -0400 `cd047cd`: `ma-tasks-plugin` `Task` `add_many` accepts tree-shaped `items: [{title, children?}]` so parents and depth-2 subtasks can be created in one call. `titles` XOR `items`; `parent` only with flat `titles`. Schema, handler validation, README, one-line PROMPT note, tests.
- 2026-07-12 14:53:36 -0400 (this session): `ma-agents-md-plugin` landed. Injects [AGENTS.md](https://agents.md) into the system prompt at session start: user-global from the resolved agent home (`MINIMAL_AGENT_HOME/AGENTS.md`, never hardcoded `~/.minimal-agent`), then project from `<cwd>/AGENTS.md`. Order is global first, project second; missing/empty/oversized files are silent. Shared `promptFragments` seam so both legacy `Agent` and modern `AgentCore` pick it up via `getPromptBlockAsync`. Disable with `--no-agents-md` / `--no-agents` / `MINIMAL_AGENT_NO_AGENTS_MD=1` / `--disable-plugin agents-md` / `plugins["agents-md"].enabled = false`. Config knobs: `global`, `project`, `maxBytes` (default 100k per file). Unit + PluginLoader integration tests.
- 2026-06-04 (this session): `ma-background-plugin` landed. Four tools (`BackgroundRun`, `BackgroundStatus`, `BackgroundLogs`, `BackgroundStop`) that run bash-like commands in the background and let the model check status, read output, and cancel, without blocking the conversation. It is "sub-agents for raw bash": it copies the sub-agents plugin's proven shapes (Repository over a per-session JSONL, discriminated-union job state, a pure reconcile reducer plus an imperative shell, injected dependencies for every OS touch, a once-a-second heartbeat slot that injects a completion digest between turns) but models a raw OS process rather than an LLM worker. Persistence is durable and colocated with session history: an index at `~/.minimal-agent/sessions/<sid>.bgjobs.jsonl`, plus per-job `<jobId>.log` (full raw combined stdout+stderr, ANSI preserved, never truncated on disk) and `<jobId>.status.json` sidecars under `<sid>.bgjobs/`. Model-facing log reads are bounded (tail / line range / grep / a `since` byte cursor for streaming) and ANSI-stripped by default. Timeouts default to 10 minutes, are model-settable to any friendly duration (`"90s"`, `"2h"`, `"1d"`), clamp to a 1-day ceiling, and gate an operator-only infinite escape hatch. The load-bearing piece is a three-process model: the plugin handler spawns one detached supervised runner per job (`bin/runner.ts`) with `stdin: "pipe"`, and the runner spawns the actual `bash -c` in its own process group. The harness holds the runner's stdin write end open; when the harness exits by ANY means including SIGKILL, the OS closes that pipe, the runner sees stdin EOF, group-kills the job and its descendants, records the outcome, and exits, so no job ever leaks. Defense in depth adds a graceful `process.on(exit/SIGINT/SIGTERM/SIGHUP)` fan-out (one shared listener, not one per job), a ppid poll, and startup reconciliation of orphans. 199 tests: pure logic with injected fakes (no real process), plus three integration suites running real sub-second jobs through the real runner, including a test that proves closing the runner's stdin kills the job and its grandchild.
- 2026-06-04 (this session): `ma-chrome-cdp-plugin` landed. One tool (`ChromeCDP`) that drives an already-running Chrome over the DevTools Protocol, inside the user's real logged-in browser. Convenience actions cover tabs, JS eval (page and cross-origin iframe), navigation, and downloads. The `send` action is a generic passthrough to ANY CDP method (`Network.*`, `Performance.*`, `Tracing.*`, `Profiler.*`, `DOM.*`, `Emulation.*`, and the rest), so the whole protocol is reachable without hand-coding each domain. A persistent background daemon holds ONE connection to the browser over a unix socket, so macOS prompts for Local Network access once, not per command. CDP events are async pushes with no reply, so the daemon buffers them in a bounded ring: enable a domain via `send`, then drain with `events` (filter, `since` cursor, limit, clear). Protocol errors come back as `{__error}` values rather than throwing. 117 tests across client / connection / dispatch / evaluate / events / input / profile / protocol / render / routes and the handler, all against a fake transport so no real Chrome runs.
- 2026-06-03 22:57:38 -0400 (this session): `ma-speak-plugin` landed. Three tools (`Speak`, `SpeakStatus`, `SpeakStop`) that read text aloud through a swappable speech backend (default `macos-say`, wrapping `/usr/bin/say`). The model controls only `text` + `wait`. Voice, rate, and binary are operator config, so the tool is backend-agnostic and the model never learns which engine speaks. Lifecycle is the inverse of a normal tool: speech OUTLIVES the call. The handler spawns the backend detached (own process group), registers the job in an in-process module-singleton registry, and returns a short handle (`s1`) immediately while audio plays in the background. A reaper settles the job on exit. `SpeakStop` group-kills (SIGTERM then SIGKILL after a grace window) so the underlying speech CLI dies with the wrapper, and a parent-exit hook SIGKILLs any in-flight utterance if the agent exits (macOS does not propagate parent death). Backend-agnostic failure taxonomy keeps raw stderr and engine identity off every model-facing surface. 80 tests across config / registry / backend / render / macos-say / three handlers, all injecting a fake `spawnFn` so no real `say` runs (fast, offline, silent).

### Fixed

- 2026-08-10 (this session): `ma-history-edit-plugin` now enters a synchronous
  staging state before beginning a selected prompt's asynchronous rewind
  transaction. Repeated Enter is deduplicated, Escape invalidates an in-flight
  request, failed staging restores the picker, and a late success cannot reopen
  a canceled editor.

- 2026-08-10 (this session): `ma-history-edit-plugin` no longer mistakes a
  short tail of assistant/tool records for an empty prompt history. The picker
  now pages backward through the active session until it finds all saved user
  prompts, then shows newest first. Regression coverage reproduces a tail with
  no user rows followed by an older prompt.

- 2026-08-09 17:01:27 -0400 `0ae2701`: OpenAI / Grok / OpenCode Responses stream translators now delete the text block on `response.output_text.done`, so the later `response.content_part.done` for the same part does not emit a second `text_stop`. Observed on Judy `699995c8`: assistant messages stored two identical `content[]` text parts and `onTextStop` fired twice. Fixture coverage in `ma-llm-openai-plugin/openai.stream-fixtures.test.ts`.
- 2026-07-31 11:45:59 -0400 (this session): `ma-web-search-plugin` accepts Cursor-style `search_term` (and `q` / `search` / `searchQuery`) as aliases for the canonical `query` field. Cursor-trained models (observed on Kevin `71826f71`, `cursor-grok-4.5-high-fast`) were calling `WebSearch` with `{search_term, explanation}` and getting `` `query` is required `` even though a usable search string was present. `explanation` remains ignored. Schema/PROMPT still teach `query` as the required arg. Regression tests replay Kevin's exact payloads.
- 2026-07-31 11:43:42 -0400 (this session): `ma-fetch-plugin` no longer rejects plain page fetches when the model dumps every optional schema field with `eval: ""` and `eval_mode: "value"|"page"`. Empty/`missing` `eval` now ignores `eval_mode` (same as empty `selector`), so Terra-style full-arg calls succeed as normal markdown fetches instead of `` `eval_mode` requires a non-empty `eval` expression ``. Observed on Karen `502dbb7b` (Proxmox / Docker / Dokku research).
- 2026-07-30 18:11:15 -0400 (this session): OpenAI-compatible Chat stream translators (`ma-llm-*/lib/openai-chat.ts`, synced from core `plugin-api`) now emit `thinking_stop` **before** the first `text_delta` when a transition chunk carries both `content` and `reasoning_content: null` (DeepSeek / OpenCode Go). Previously `text_delta` ran first, so the host REPL's `onThinkingStop` blank-line separator orphaned short bright prefixes mid-word (`Pre` / `Plug` / `All`) in scrollback. Also closes open thinking before tool-call deltas. Fixture assert in `ma-llm-openai-plugin/openai.stream-fixtures.test.ts`; core unit coverage in `plugin-api` `openai-chat.test.ts`.
- 2026-07-29 03:20:00 -0400 (this session): `ma-tasks-plugin` `add_many` no longer rejects `children: []` on an `items` entry. Empty arrays are now silently ignored (treated as absent) instead of returning `` `items[N].children` must be non-empty ``. Models often emit `children: []` on leaf items, and killing the whole plan for a vacuous field was gratuitous.
- 2026-07-29 01:52:03 -0400 (this session): Grok (and ClinePass) session-info prime no longer picks the first `auth.jsonc` OAuth entry or a stray env API key when the session used `--credential-name` / OAuth. Host now forwards `credentialName` + `authKind` into `primeSessionInfo`. Free accounts with `monthlyLimit: 0` cache billing without painting a bogus `month` bar (and stop re-GETting `/billing` every turn); `ondemand` window when `onDemandCap > 0`. Weekly CLI `creditUsagePercent` still not on raw `/v1/billing`.
- 2026-07-24 (this session): `ma-env-info-plugin` host snapshot (`cwd=`, os, git, session id, …) no longer disappears when the operator launches with `--no-system-session-context` / omits `systemPrompt.sessionContext`. The `snapshot` fragment now uses `placement: "afterInstructions"` (plain markdown, with a short `# Environment` heading + fenced `ini` block from `gather.sh`) instead of riding only in the XML-wrapped sessionContext slot that that flag strips. Framing moved out of `PROMPT.md` into the fragment so GPT/Claude sessions do not get a duplicate empty Environment section. Root cause observed on Grok monorepo sessions (e.g. Leon `67ab8ffe`) that grepped a stale `~/Projects/minimal-agent` symlink into `minimal-agent-core` because absolute `cwd=` was never in the system prompt.
- 2026-07-24 (this session): `ma-llm-cursor-plugin` now sends AgentService/Run through the host-injected `NetworkClient`, explicitly pinned to `protocol: "h2"`, instead of bypassing observers with a private per-call HTTP/2 session. Cursor turns therefore participate in the shared connection pool, policies, activity reporting, and `MINIMAL_AGENT_NET_DBG=1` capture. Connect/protobuf request bytes are captured losslessly as base64 while response status/headers remain visible without duplicating streamed model output on disk; raw `node:http2` and curl remain explicit developer-only fallbacks because the Bun-fetch stream issue does not apply to the host's node:http2 transport.
- 2026-07-23 (this session): `ma-fetch-plugin` L0 strip of oversized `data:*;base64,…` URIs from `markdown` / `text` / `html` output (`lib/data-uri.ts` + handler post-cleanup). Matches core `<ma::agent::redacted-asset>` stubs so TUI `display` is clean before tool-round; core re-scrubs as safety net. Unit tests for keep-tiny / scrub-large / no-op.
- 2026-07-23 (this session): `ma-fetch-plugin` no longer dumps binary bodies (PDF / images / zip) into model context as UTF-8 mojibake when `format: "original"` (or any format) hits a non-text resource. Bytes are sniffed (magic + NUL/control heuristics), persisted under the session blob dir, and replaced with a `<ma::agent::binary-result mime size path sha256 tool="Fetch" />` summary unless the model passes `binary: true` (base64 under a 48 KiB raw cap). Manifest declares `mayReturnBinary: true` so core injects the `binary` opt-in arg. `lib/binary.ts` + handler/backend tests cover PDF withhold, base64 opt-in, and text passthrough. Does not touch multimodal Read image blocks or user file uploads.
- 2026-07-23 (this session): `ma-tasks-plugin` dual ALL DONE / token waste on redundant parent `done`. After last-child auto-promote, models (e.g. Grok) often also `done` the parent in the same turn; both calls returned full boards + identical `✔ ALL DONE` frames (Lisa sid `acee5759`). `done` / `status→done` on an already-`done` id now short-circuits to compact `already_done` (self-closing `<ma::agent::tasks … />`, empty display body, dim "already done #hash" header, no celebration). PROMPT + tool description harden "do not also done the parent". Regression tests cover Lisa path + render header.
- 2026-07-16 (this session): `ma-intercom-plugin` TUI chrome (#592820 / #58482 / #84819). Distinct tool icons (`◎` Peers / `→` Send / `↓` Inbox). Send header is destination-only (`→ Sergio (3782589f)`); body is message only. Arrival: one toast per message (`↓ Intercom  from Name (short)`), body = text only, footer = model; interrupt puts palette-red urgency in the title. Host `displayHeader` gap is single-space for plugin overrides (core). Named peers as `Name (short)`. Optional `from.name` on envelopes.
- 2026-07-16 09:06:41 -0400 (this session): `ma-tasks-plugin` parents now reflect subtree progress. Starting a child auto-starts its parent; completing a child while siblings remain open keeps/marks the parent `doing`; the last done child still auto-promotes it to `done`. Canceled parents are never revived. Parent duration rendering uses `max(parent span, summed child work)` to avoid double-counting the auto-started parent and child interval.
- 2026-07-15 02:54:25 -0400 (this session): `ma-tasks-plugin` `Task` `start` no longer demotes other `doing` tasks back to `todo`. Previously started rows stay `doing` until explicitly `done`, `canceled`, or set to `todo`. `parallel` remains accepted as a compat no-op. Store, tests, PROMPT/README/manifest/CLI docs updated. Package-local `tsdoc.json` extends the repo root so package-dir `oxlint` loads the `@module` tag definition.
- 2026-07-12 22:38:39 -0400 (this session): `ma-tasks-plugin` review follow-ups for tree `add_many`: preflight max 26 children (items + titles+parent) so overflow never leaves a partial write; reject `after` with `add_many`; reject unknown keys on `items[i]` (mirror schema `additionalProperties:false`); reject `items` on non-`add_many` actions; tiny `items` example in PROMPT.
- 2026-07-12 21:40:02 -0400 `c48e6af` (+ `225a370` format): `ma-diagnostics-plugin` stopped inventing false type errors on clean in-project edits. Root cause: when the project typecheck returned empty, the out-of-scope fallback ran `tsc --ignoreConfig <file>`, which drops `jsx`, `paths`, and every other project option — so `@/…` imports became TS2307 and `.tsx` Storybook/UI files became TS17004 / TS6142 ("`--jsx` is not set"). Fixes:
  - Type providers (`TscSpawnProvider`, `TsLspProvider`) implement `inScope()` via new `lib/tsconfig-scope.ts` (classic TS ≤6 program parse when available; lightweight include/exclude match for TS 7). Clean in-project files no longer fall through to ad-hoc.
  - `TscDirectProvider` no longer uses `--ignoreConfig`. It writes a temp config that `extends` the nearest `tsconfig.json` and `include`s only the target file, preserving project options. No-tsconfig fallback defaults include `--jsx react-jsx`.
  - Regression coverage: service test for the in-scope skip path, unit tests for scope matching, integration test that a `.tsx` with `@/` outside include does not invent TS17004/TS6142/TS2307.
- 2026-05-31 (this session): code-review pass across all four plugins. Six real bugs fixed (gate was already green), each fix has a regression test.
  - `ma-fetch` + `ma-skills` `lib/jsonc.ts`: trailing-comma stripping ran as a global regex over the whole stripped document, so a `,}` or `,]` **inside a string value** (a CSS selector, User-Agent, or `eval` snippet in user config) was silently corrupted. Trailing-comma elision now happens inside the scanner and never touches string spans. New `ma-fetch-plugin/lib/jsonc.test.ts`.
  - `ma-skills` `lib/skill-md.ts`: a CRLF-authored `SKILL.md` (Windows line endings) was rejected wholesale because the trailing `\r` defeated the `key: value` regex. Frontmatter lines are now CRLF-normalised before parsing.
  - `ma-skills` `lib/skill-md.ts`: duplicate keys inside a nested `metadata:` map were silently overwritten; now flagged, mirroring the top-level duplicate-key guarantee.
  - `ma-fetch` `handlers/fetch.ts` + `lib/backend.ts`: the wall-clock watchdog kill (backend wedged past its own `--timeout`) was reported to the model as "aborted by user". The abort reason now travels out and produces a time-budget timeout message; parent-exit shutdown is also distinguished.
  - `ma-fetch` `lib/errors.ts`: `newTraceId` could emit a too-short / empty random suffix; now a fixed 6-hex-digit suffix.
  - `ma-slash-menu` `lib/render.ts`: `overlayHeight()` under-counted by one row when the list was scrolled (it ignored the `↑ N more` affordance row), contradicting its own "maximum rows" contract.
  - `ma-slash-menu` `manifest.json`: declared the unused `hooks:editor.buffer.set` permission and omitted `hooks:editor.footer.set`, the channel it actually emits on every render. Swapped.
  - `ma-slash-menu` `lib/tokens.ts`: token estimate counted UTF-16 code units instead of UTF-8 bytes, contradicting its documented `bytes / 4` heuristic; now measures bytes.

### Changed

- 2026-08-05 (this session): GitHub Actions — `actions/checkout@v7` (was v6);
  CI/release install steps set `HUSKY=0`.
- 2026-05-22 (this session): `.gitignore` extended with `.*-dbg/`, `.*-debug/`, `.*.dbg/` patterns. Catches debugger scratch folders like `.net-dbg/` without per-folder rules.

## 2026-05-22

### Added

- 15:11:44 -0400 `2bc53eb`: `ma-agent-writing-style-plugin` landed. Pure prompt fragment, no tools. Hard bans em-dashes and semicolons, kills the AI vocabulary, suppresses sycophancy and significance inflation.

### Changed

- 15:12:05 -0400 `aff2598`: `ma-skills-plugin` PROMPT.md and README scrubbed of em-dashes and prose semicolons.

## 2026-05-20

### Fixed

- 10:54:07 -0400 `d1abcc1`: `ma-skills-plugin` SKILL.md frontmatter parser now accepts multi-line scalars.

## 2026-05-19

### Added

- 18:07:35 -0400 `31ddf2f`: `ma-skills-plugin` phase 7. Registered in parent README. Final wrap.
- 18:03:38 -0400 `bd0f65f`: `ma-skills-plugin` phase 6. Manifest, PROMPT.md, README.md.
- 18:00:41 -0400 `e027017`: `ma-skills-plugin` phase 5. `Skill` tool handler (`list` / `info` / `read`).
- 17:57:47 -0400 `48e4bbb`: `ma-skills-plugin` phase 4. Prompt-fragment producer that emits the Level 1 skill catalog into the system prompt.
- 17:55:55 -0400 `184f8bc`: `ma-skills-plugin` phase 3. Skill discovery walker and `allowed-tools` support.
- 17:53:11 -0400 `8be9172`: `ma-skills-plugin` phase 2. SKILL.md parser and validator.
- 17:49:34 -0400 `7f5644e`: `ma-skills-plugin` phase 1. Foundation (types, jsonc reader, config).

## 2026-05-18

### Added

- 17:43:24 -0400 `bb77eae`: Initial commit. `ma-fetch-plugin` with the `Fetch` tool and a headless-browser backend (default: [obscura](https://github.com/h4ckf0r0day/obscura)).
