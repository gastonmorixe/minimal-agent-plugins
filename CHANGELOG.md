# Changelog

All notable changes to this repository. Loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Each entry is prefixed with a local-time timestamp (`HH:MM:SS ±HHMM`) and the short commit hash when one exists. Entries without a hash are working-tree changes that haven't been committed yet.

## [Unreleased]

### Added
- 2026-06-04 (this session): `ma-chrome-cdp-plugin` landed. One tool (`ChromeCDP`) that drives an already-running Chrome over the DevTools Protocol, inside the user's real logged-in browser. Convenience actions cover tabs, JS eval (page and cross-origin iframe), navigation, and downloads. The `send` action is a generic passthrough to ANY CDP method (`Network.*`, `Performance.*`, `Tracing.*`, `Profiler.*`, `DOM.*`, `Emulation.*`, and the rest), so the whole protocol is reachable without hand-coding each domain. A persistent background daemon holds ONE connection to the browser over a unix socket, so macOS prompts for Local Network access once, not per command. CDP events are async pushes with no reply, so the daemon buffers them in a bounded ring: enable a domain via `send`, then drain with `events` (filter, `since` cursor, limit, clear). Protocol errors come back as `{__error}` values rather than throwing. 117 tests across client / connection / dispatch / evaluate / events / input / profile / protocol / render / routes and the handler, all against a fake transport so no real Chrome runs.
- 2026-06-03 22:57:38 -0400 (this session): `ma-speak-plugin` landed. Three tools (`Speak`, `SpeakStatus`, `SpeakStop`) that read text aloud through a swappable speech backend (default `macos-say`, wrapping `/usr/bin/say`). The model controls only `text` + `wait`. Voice, rate, and binary are operator config, so the tool is backend-agnostic and the model never learns which engine speaks. Lifecycle is the inverse of a normal tool: speech OUTLIVES the call. The handler spawns the backend detached (own process group), registers the job in an in-process module-singleton registry, and returns a short handle (`s1`) immediately while audio plays in the background. A reaper settles the job on exit. `SpeakStop` group-kills (SIGTERM then SIGKILL after a grace window) so the underlying speech CLI dies with the wrapper, and a parent-exit hook SIGKILLs any in-flight utterance if the agent exits (macOS does not propagate parent death). Backend-agnostic failure taxonomy keeps raw stderr and engine identity off every model-facing surface. 80 tests across config / registry / backend / render / macos-say / three handlers, all injecting a fake `spawnFn` so no real `say` runs (fast, offline, silent).

### Fixed
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
