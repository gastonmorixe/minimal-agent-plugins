# Changelog

All notable changes to this repository. Loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Each entry is prefixed with a local-time timestamp (`HH:MM:SS ±HHMM`) and the short commit hash when one exists. Entries without a hash are working-tree changes that haven't been committed yet.

## [Unreleased]

### Added
- 2026-07-15 (this session): `ma-llm-clinepass-plugin` landed. ClinePass provider (OpenAI-compatible open-weight catalog via `api.cline.bot`). API key + WorkOS device-code OAuth, 10 `cline-pass/*` models, session quota windows from rate-limit headers, package-local `tsdoc.json`. 14 unit tests.
- 2026-07-15 01:45:31 -0400 (this session): `ma-intercom-plugin` `@`-mention peer autocomplete + dual representation. Typing `@` opens a slash-menu-style fuzzy peer list (footer overlay) sorted online-first with status colors, name/short sid/pid/model/cwd. Matching `@tokens` paint live via `editor.buffer.styles` (violet/purple bold). On the model path, `turn.willStart` rewrites uniquely resolved tokens to peer XML while scrollback/queue keep the styled `@token`. Wire form in `lib/mention/PROMPTS.ts`. `resolvePeer` matches display names. Handlers: `on_key` (prio 65), `on_buffer_changed`, `on_turn_will_start`. Package-local `tsdoc.json`. 41 pure-lib tests. README section.
- 2026-07-12 22:32:03 -0400 `cd047cd`: `ma-tasks-plugin` `Task` `add_many` accepts tree-shaped `items: [{title, children?}]` so parents and depth-2 subtasks can be created in one call. `titles` XOR `items`; `parent` only with flat `titles`. Schema, handler validation, README, one-line PROMPT note, tests.
- 2026-07-12 14:53:36 -0400 (this session): `ma-agents-md-plugin` landed. Injects [AGENTS.md](https://agents.md) into the system prompt at session start: user-global from the resolved agent home (`MINIMAL_AGENT_HOME/AGENTS.md`, never hardcoded `~/.minimal-agent`), then project from `<cwd>/AGENTS.md`. Order is global first, project second; missing/empty/oversized files are silent. Shared `promptFragments` seam so both legacy `Agent` and modern `AgentCore` pick it up via `getPromptBlockAsync`. Disable with `--no-agents-md` / `--no-agents` / `MINIMAL_AGENT_NO_AGENTS_MD=1` / `--disable-plugin agents-md` / `plugins["agents-md"].enabled = false`. Config knobs: `global`, `project`, `maxBytes` (default 100k per file). Unit + PluginLoader integration tests.
- 2026-06-04 (this session): `ma-background-plugin` landed. Four tools (`BackgroundRun`, `BackgroundStatus`, `BackgroundLogs`, `BackgroundStop`) that run bash-like commands in the background and let the model check status, read output, and cancel, without blocking the conversation. It is "sub-agents for raw bash": it copies the sub-agents plugin's proven shapes (Repository over a per-session JSONL, discriminated-union job state, a pure reconcile reducer plus an imperative shell, injected dependencies for every OS touch, a once-a-second heartbeat slot that injects a completion digest between turns) but models a raw OS process rather than an LLM worker. Persistence is durable and colocated with session history: an index at `~/.minimal-agent/sessions/<sid>.bgjobs.jsonl`, plus per-job `<jobId>.log` (full raw combined stdout+stderr, ANSI preserved, never truncated on disk) and `<jobId>.status.json` sidecars under `<sid>.bgjobs/`. Model-facing log reads are bounded (tail / line range / grep / a `since` byte cursor for streaming) and ANSI-stripped by default. Timeouts default to 10 minutes, are model-settable to any friendly duration (`"90s"`, `"2h"`, `"1d"`), clamp to a 1-day ceiling, and gate an operator-only infinite escape hatch. The load-bearing piece is a three-process model: the plugin handler spawns one detached supervised runner per job (`bin/runner.ts`) with `stdin: "pipe"`, and the runner spawns the actual `bash -c` in its own process group. The harness holds the runner's stdin write end open; when the harness exits by ANY means including SIGKILL, the OS closes that pipe, the runner sees stdin EOF, group-kills the job and its descendants, records the outcome, and exits, so no job ever leaks. Defense in depth adds a graceful `process.on(exit/SIGINT/SIGTERM/SIGHUP)` fan-out (one shared listener, not one per job), a ppid poll, and startup reconciliation of orphans. 199 tests: pure logic with injected fakes (no real process), plus three integration suites running real sub-second jobs through the real runner, including a test that proves closing the runner's stdin kills the job and its grandchild.
- 2026-06-04 (this session): `ma-chrome-cdp-plugin` landed. One tool (`ChromeCDP`) that drives an already-running Chrome over the DevTools Protocol, inside the user's real logged-in browser. Convenience actions cover tabs, JS eval (page and cross-origin iframe), navigation, and downloads. The `send` action is a generic passthrough to ANY CDP method (`Network.*`, `Performance.*`, `Tracing.*`, `Profiler.*`, `DOM.*`, `Emulation.*`, and the rest), so the whole protocol is reachable without hand-coding each domain. A persistent background daemon holds ONE connection to the browser over a unix socket, so macOS prompts for Local Network access once, not per command. CDP events are async pushes with no reply, so the daemon buffers them in a bounded ring: enable a domain via `send`, then drain with `events` (filter, `since` cursor, limit, clear). Protocol errors come back as `{__error}` values rather than throwing. 117 tests across client / connection / dispatch / evaluate / events / input / profile / protocol / render / routes and the handler, all against a fake transport so no real Chrome runs.
- 2026-06-03 22:57:38 -0400 (this session): `ma-speak-plugin` landed. Three tools (`Speak`, `SpeakStatus`, `SpeakStop`) that read text aloud through a swappable speech backend (default `macos-say`, wrapping `/usr/bin/say`). The model controls only `text` + `wait`. Voice, rate, and binary are operator config, so the tool is backend-agnostic and the model never learns which engine speaks. Lifecycle is the inverse of a normal tool: speech OUTLIVES the call. The handler spawns the backend detached (own process group), registers the job in an in-process module-singleton registry, and returns a short handle (`s1`) immediately while audio plays in the background. A reaper settles the job on exit. `SpeakStop` group-kills (SIGTERM then SIGKILL after a grace window) so the underlying speech CLI dies with the wrapper, and a parent-exit hook SIGKILLs any in-flight utterance if the agent exits (macOS does not propagate parent death). Backend-agnostic failure taxonomy keeps raw stderr and engine identity off every model-facing surface. 80 tests across config / registry / backend / render / macos-say / three handlers, all injecting a fake `spawnFn` so no real `say` runs (fast, offline, silent).

### Fixed
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
