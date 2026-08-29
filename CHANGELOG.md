# Changelog

All notable changes to this repository. Loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Each entry is prefixed with a local-time timestamp (`HH:MM:SS ±HHMM`) and the short commit hash when one exists. Entries without a hash are working-tree changes that haven't been committed yet.

## [Unreleased]

### Fixed

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
