# Changelog

All notable changes to this repository. Loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Each entry is prefixed with a local-time timestamp (`HH:MM:SS ±HHMM`) and the short commit hash when one exists. Entries without a hash are working-tree changes that haven't been committed yet.

## [Unreleased]

### Changed

- 2026-11-20: **The Intercom footer paints the session title faint**
  (`ma-intercom-plugin`). `renderFooter` wraps the title in the `dim` style
  (SGR 2, closed with SGR 22). The title is sanitized first, so it cannot
  close the faint style early or start a style of its own. The other
  segments keep their styles. The footer text and its width do not change.
- 2026-11-20: **A new title shows in the Intercom footer at once**
  (`ma-title-plugin`, `ma-intercom-plugin`). After `setTitle` wrote an AI
  title, the title plugin sends one `title.saved` event
  (`{sid, title, source: "ai"}`) on the plugin bus. It sends no event when it
  wrote no title, and an error in the emit does not change the result of the
  write. The `intercom_beat` slot now has `"refreshOn": ["title.saved"]`, so
  the host scheduler runs it again at once and the footer shows
  `⇆ intercom · N online · <title>` with no wait of up to 5 s. The 5 s timer
  stays: it shows the title of a resumed session, which has no event. There
  is no core or CLI change: the scheduler already supports `refreshOn`. A
  test in `tests/` checks that the event name and the `refreshOn` list stay
  equal.
- 2026-11-20: **Background jobs: a headless run waits for its jobs**
  (`ma-background-plugin`, `ma-sub-agents-plugin`). A headless run (`-p`,
  `stream-json`, a sub-agent worker) exited when its turn ended, and the
  runner then killed its jobs ("harness exited"). A new `turn.willStop`
  hook (`handlers/on_turn_will_stop.ts`, `lib/headless-wait.ts`, priority
  40, `timeoutMs` 25 min, permission `hooks:turn.willStop`) acts only when
  `ctx.run.interactive` is false and the mode is `one-shot`, `stream-json`
  or `subagent` (fallback with no `ctx.run`: payload `agentId` or
  `MINIMAL_AGENT_WRAP_UP_TOOLS`). It polls the reconcile pass each second
  (unref'd timers) until the session's jobs end, then halts with their
  digests, so the model gets one more round. It stops at once on the hook
  abort (the turn signal on a core that gives it), SIGTERM, SIGINT or SIGHUP
  (fan-out tagged listener, owner-count rule). The max wait
  `MINIMAL_AGENT_BG_HEADLESS_WAIT_MS` (default 20 min, max 24 min) is a
  total for each turn and session (reset on a new turn and on an allow with
  no running job); a worker also stops at its budget deadline minus 60 s.
  At the deadline one "continues to run" halt (singular and plural forms),
  then an allow when nothing changed. Opt out:
  `MINIMAL_AGENT_BG_HEADLESS_WAIT=0` or `MINIMAL_AGENT_DISABLE_BGJOBS=1`.
  BackgroundLogs now reconciles the job it reads (`runReconcile` gets an
  optional `onlyId`). In a headless run the BackgroundRun result says that
  the turn stays open (core `TUIContext.run`; an older core: workers only).
  The worker result protocol gets one sentence (prompt-bytes fixtures
  updated). PROMPT.md and the request goldens do not change.
- 2026-11-20: **Fetch: concurrency-safe calls without a named session**
  (`ma-fetch-plugin`, SPEC D6-D8). The manifest sets
  `trigger.tool.concurrencySafe: true`. The handler export
  `concurrencySafe(input)` gives true only when `session` is absent or
  `""` and the config sets no `defaults.session`. Calls with a named
  session stay serial. At most 4 one-shot processes run at the same
  time (env `MINIMAL_AGENT_FETCH_MAX_CONCURRENT`, an integer of 1 or
  more; an incorrect value gives 4). Other calls wait in arrival order.
  The reason: 10 calls at the same time had a measured peak RSS of
  3.7 GB, and nytimes.com alone used 2.3 GB. The time budget and the
  watchdog start after the call gets its slot. An abort while a call
  waits removes it from the queue. When the persistent worker is busy, a
  concurrency-safe call uses the one-shot path, so at most 5 processes
  render at the same time (the worker plus 4 one-shot processes). The
  plugin reads the env one time for each process. The tool `durationMs`
  includes the slot wait.
- 2026-11-19: **Intercom footer shows the session title** (`ma-intercom-plugin`).
  The footer line is now `⇆ intercom · 2 online · 1 busy · <title>`. The title
  is the saved title of this session (user, then AI, then derived). The beat
  slot reads it on each beat (every 5 s) with the new `sessions:read` method
  `title(sid)`, so a new or renamed title shows at the next beat. It also
  shows when no peer is online (`⇆ intercom · 0 online · <title>`). The title
  loses control characters and escape sequences before it is painted. It is
  never written to the presence record and never goes to a peer. A host with
  no `title` method gives the footer as before.
- 2026-11-20: **Sub-agents: soft budget tags, SIGTERM grace and salvage**
  (`ma-sub-agents-plugin`). A worker gets a `budget` sideband tag in a tool
  result at 75 % (`warn`) and 90 % (`final`) of its deadline, or near its
  `maxTurns` (env `MINIMAL_AGENT_SUBAGENT_BUDGET` and
  `MINIMAL_AGENT_SUBAGENT_STARTED_AT`). At the deadline or at `maxTurns`, the
  supervisor sends SIGTERM one time and gives a 60 s grace. The worker runs
  one wrap-up turn that can call only `SubAgentsReportResult` (env
  `MINIMAL_AGENT_WRAP_UP_TOOLS`), then the supervisor sends SIGKILL. A
  `maxTokens` trip gets no grace (SIGKILL at once). A worker that ends in the
  grace with no result is `failed` with the limit text, and its final message
  (max 8000 characters) is kept as `salvage` for `AgentResult`. The digest and
  the canceled linked task tell the lead about the salvage. `AgentStatus` and
  `ListAgents` show `stopping` in the grace. The probe reads the stream before
  the sentinel, so a sentinel written at the run end is not missed. The
  ma-hooks and ma-background READMEs now name the core file-lock listener as a
  fan-out listener.

- 2026-11-19: **Titles: same request layout as Claude Code**
  (`ma-title-plugin`). The system prompt keeps all the rules. The user
  message is the `<session>` block, then one language line. Default line:
  the main language of the text. New optional key `plugins.title.language`
  and env `MINIMAL_AGENT_TITLE_LANGUAGE` (env wins; letters, spaces and
  hyphens, 40 characters maximum; a bad value is ignored).

- 2026-11-19: **Titles: default ON in the interactive REPL** (`ma-title-plugin`,
  SPEC P1b). `DEFAULT_ON_MODES` is now `["repl"]`. With no env and no config,
  the plugin makes a title in the interactive REPL only. One-shot,
  stream-json and host stay off by default. A sub-agent is always off, also
  with an inherited `MINIMAL_AGENT_TITLE=1`. To stop it: `MINIMAL_AGENT_TITLE=0`
  or `"plugins": { "title": { "enabled": false } }`. `plugins.title.modes`
  replaces the default list.

- 2026-11-19: **Titles: the provider title profile only; Anthropic reads
  non-stream replies** (`ma-title-plugin`, `ma-llm-anthropic-plugin`). The
  title plugin uses only `host.models.utilityFor(<session provider>)`. A
  provider with no title profile gets no title request (`stopReason:
  "no-model"`). The `utility` and `haiku` tag steps, the session model step,
  `allowSessionModel` and `allowOtherProvider` are removed. The model
  override must be a model of the session provider. The effort comes from the
  profile; the new key `plugins.title.effort` replaces it. The output limit is
  256 tokens (it was 128). The Anthropic `recommendUtilityModel()` now gives
  `effort: "low"` and `stream: "off"`. The Anthropic adapter reads a
  non-stream JSON reply when the request has `stream: false` (new
  `response-message.ts`); before, it read only SSE.

- 2026-11-19: **New `ma-title-plugin`: a short AI title for each session**
  (`ma-title-plugin`, `ma-llm-anthropic-plugin`). On the first typed prompt
  (10 or more characters, not a `/` command, `source: "user"`), the plugin
  sends one request to the utility model of the session provider with a JSON
  schema, thinking off and effort low. It saves the title as a `kind:
  "title"` line in `index-meta.jsonl`; `ma sessions` shows it with `✦`.
  Default OFF: turn it on with `MINIMAL_AGENT_TITLE=1` or
  `plugins.title.modes`. Kill switch `MINIMAL_AGENT_TITLE=0`. Sub-agents make
  no title. It sends only the first prompt (max 2000 characters) to the
  session provider; a model of another provider needs
  `allowOtherProvider: true`. Max 2 requests for each session in each
  process; a price ceiling of $1 for each million input tokens. Cost on
  `claude-haiku-5-5`: about $0.0001 for each title. Each attempt sends one
  `title.attempt` event. The Anthropic plugin declares its utility model:
  new `recommendUtilityModel()` (`ANTHROPIC_UTILITY_MODEL_ORDER`:
  `claude-haiku-5-5`, then `claude-haiku-4-5-20251001`) and the tag
  `utility` on these two models. Details in `ma-title-plugin/README.md`.

- 2026-11-18: **The cache plugin reports every prompt-cache break as a fact,
  and frontends show breaks from that fact, not from the log severity**
  (`ma-cache-plugin`, `ma-acp-plugin`). Before, the cause chose the log
  level and each frontend dropped info, so a break that the plugin called
  expected was not shown: a 63 min idle turn rewrote 26,426 tokens with only
  an info log line and no token count. A replay of 42 recorded Anthropic
  sessions found 113 breaks (19.2M tokens rewritten); the TUI showed a
  warning for 36 of them, so 77 (13.8M tokens) were hidden.
  - Each break sends one `cache.didBreak` bus event and one `cache.break`
    notice diagnostic (for a host without bus access), with no once-per-code
    or milestone limit. The fields are in the `README.md`.
  - The prefix check runs before the TTL check, so an idle gap does not hide
    a client change: a changed prefix after an idle time is `prefix_changed`
    with `idle: true`, not `ttl_expired`.
  - New breaks with cause `unknown`: a warm turn followed by a request with
    no cache markers, and a warm turn followed by a turn that neither read
    nor wrote the cache. A small `messages_changed` write after the thinking
    removal is now a break event (not actionable), and still has no
    diagnostic.
  - `server_miss` is a warning (was info), with the request id. The warning
    comes at 1, 3, 10, 30, ... server misses in a row; the break event comes
    each time. `ttl_expired` stays info and now gives `written` and `lost`.
  - ACP: a client with `session.notices` gets a notice for each break
    (`warning` when actionable, else `info`). A client without notices gets
    the break as answer text only when an actionable run starts. The
    `cache.anomaly` codes that are also a break (`prefix_changed`,
    `server_miss`, `ttl_expired`) give no notice now, so one break is one
    notice.
  - Not decided yet: whether the client should remove the thinking of the
    previous latest assistant message. In the replay, the breaks after that
    removal are 90 of 113 and 62% of the tokens rewritten. They are
    `actionable`.

- 2026-11-18: **Request goldens: the prompt-cache anchor marker is on by
  default.** Core now sends the anchor marker unless a layer turns it off
  (`--no-cache-anchor`, `MINIMAL_AGENT_CACHE_ANCHOR=0`, or config
  `"cacheAnchor": false`). 11 request goldens change only by one added
  `cache_control` on the last block of the message before the latest
  assistant turn. The wire cap of 4 markers still drops that anchor when the
  system prompt has 3 markers. `cache-anchor-append-only.test.ts` now checks
  the default (anchor on) and `cacheAnchor: false` (one marker).
  `thinkingHistory` is unchanged and stays `strip` by default.

### Fixed

- 2026-11-18: **A skills test no longer fails on a busy machine**
  (`ma-skills-plugin/lib/tool-registry.test.ts`, "timeout kills the script and
  its background child"). On macOS the first run of a new executable file
  takes about 220 ms, and the test gave the handler a 300 ms timeout, so the
  script could be killed before it wrote its pids. The test now runs the
  script once first (the next start takes about 15 ms) and uses 500 ms. Only
  the test changes.
- 2026-11-18: **A session id in a plugin comes from the handler context first**
  (`ma-tasks-plugin`, `ma-base-prompt-plugin`). The Task tool read the session
  id from `ctx.env.MINIMAL_AGENT_SESSION_ID` only; it now takes
  `ctx.agent.sessionId` first, so each web session keeps its own board. The
  MA-02 line no longer says that every session has a transcript file: a host
  may keep the session in memory, and `SessionInfo` gives the id. The request
  goldens and the core system-prompt byte fixtures change in that line only.
- 2026-11-18: **The gate now runs in a standalone clone.** Five test files
  imported core source from a checkout next to this repo
  (`../../minimal-agent-core/src/...`). That path exists only in the umbrella
  monorepo. In a standalone clone the typecheck failed, and with a core
  checkout placed next to the clone, the process had two copies of core and
  core refused to load the second one. The tests now import through the
  installed package directory (`../node_modules/@minimal-agent/core/src/...`),
  which is the one core this repo installs in both layouts. Three type imports
  that have a public subpath use it
  (`@minimal-agent/core/plugin-api/types/synthetic-text`). New guard
  `scripts/no-sibling-core-imports.test.ts` rejects the old form. No plugin
  code changes, only tests.
- 2026-11-18: **The STE audit finds core in a standalone clone.** The audit
  (`bun run ste:gate` and `tests/ste/`) read the core text files only from a
  checkout next to this repo, and stopped when it was missing. It now uses
  that checkout when it is there, else the installed `@minimal-agent/core`.
  In the umbrella monorepo the two are the same directory.

- 2026-11-18: **SessionInfo and SessionHistory read the calling session, not
  the process** (`ma-session-info-plugin`, `ma-session-history-plugin`). In
  the web host (many sessions in one process) SessionInfo showed
  "Session: unknown" and the boot default model, and SessionHistory's default
  `last` opened the newest file on disk, an other session. SessionInfo now
  reads the session id, version, model, effort and fast flag from the handler
  context (`ctx.agent`, then `ctx.env`), and only then from `process.env`.
  SessionHistory's `last` is the calling session (`ctx.agent.sessionId`); a
  session with no saved transcript gets a clear error, not an other session.
  The old behavior is `sid: "newest"`. The request goldens change only in the
  SessionHistory `sid` description. Core gives each web session its own
  identity through the new session plugin scope.

### Added

- 2026-11-19: **The sub-agent plugin stamps the worker role and the worker
  sid in the worker env** (`ma-sub-agents-plugin`, `lib/spawn-plan.ts`).
  `MINIMAL_AGENT_SUBAGENT_ROLE` is now always set: the agent type (for
  example `worker` or `explorer`), or `""` for an inline task, so a depth-2
  worker does not keep the role of its parent worker. New
  `MINIMAL_AGENT_SUBAGENT_SID` is the child session id (the same value as
  `--session-id`); core gives the sub-agent lineage only to the session with
  this sid. Both are set after `extraEnv`, so a caller cannot change them.
  Core writes them to the session index (`role`), and the CLI `sessions`
  view shows the role under the lead.

- 2026-11-18: **The cache plugin tells a likely server-side cache miss
  apart from a client-side prompt change** (`ma-cache-plugin`). The wire
  watcher keeps a small prefix fingerprint for each request: a hash of
  `tools`, a hash of `system`, a hash of the other request options (with
  the sorted `anthropic-beta` header, without `max_tokens`, `stream`,
  `metadata` and `diagnostics`), one hash for each message (without
  `cache_control` and without assistant thinking blocks), the index of the
  last marked message, the indexes of the messages that had thinking, and
  the response `request-id` when the host gives it. A read of 0 inside the
  TTL with an unchanged prefix is the new code `server_miss` at info level
  ("likely a server-side miss: the prefix up to the previous marker is
  unchanged and the previous request read its cache"), but only when no
  thinking was removed or the previous request read at least 90% of its
  prompt. It does not start a `prefix_changed` streak. Else it is
  `prefix_changed` ("thinking removal + cache lookback: no reachable cache
  entry"). A partial read after the expected thinking removal is silent only
  when the turn wrote at most 10% of its prompt; a larger write is
  `prefix_changed` ("thinking removal; the read stays on an older entry").
  A real `prefix_changed` names the changed part: the tools, the system
  prompt, the request options, the first changed message, or a thinking
  removal from an older message. The server's `cache_missed_input_tokens`
  is now the "server-reported miss size", not "tokens missed": it is not the
  loss, the tokens written are. Replay of session bba2ddf4 requests
  080-095: request 087 (read 0, 213,492 written) was a false
  `prefix_changed` warning and is now `server_miss` with its request id;
  the other 15 requests give no diagnostic. Replay of session 932e6ae3
  R1-R26: `prefix_changed` warnings at R3, R5, R8, R10 and R17 (streak 1,
  3, 1, 3, 10), R16-R26 attributed to the thinking removal + cache
  lookback; R2 (no thinking removed) is `server_miss`.
- 2026-11-18: **The cache plugin names the cause of a cache miss and no
  longer says "evicted" or "prefix likely changed" by guess** (`353ed8f`,
  `ma-cache-plugin`). The detector takes one `CacheFacts` record for each
  request, built from the wire bytes: the marker count, the longest marker
  `ttl` (no `ttl` is 5 minutes), the prefix size, the start and end times, the
  usage counts, and the server's own reason
  (`message.diagnostics.cache_miss_reason`, sent with the
  `cache-diagnosis-2026-04-07` beta). Codes: `markers_ignored_cold` and
  `below_min_block_size` as before; `ttl_expired` at info level (a read of 0
  after a gap above the TTL, so an idle time is not a warning);
  `prefix_changed` at warning level (a read of 0 inside the TTL, or a server
  miss larger than the read), with the server's reason in the text. The
  codes `no_read_after_write` and `cache_evicted` are removed: the first said
  "prefix changed" for a 485 s expiry, and the second said "evicted" for a
  0.8 s miss. A run of misses warns again at 3, 10, 30, 100, ... misses with
  the tokens written since the first, where before one warning per code hid
  an 11-request run (about 2.1M tokens written). The turn number keeps
  counting (it stopped at 4). Replay of 79 recorded session folders: every
  warning was a real miss inside the TTL with a server reason. Not changed:
  the reset on `target.didSwitch` (only the CLI sends it), so the web host
  can still show one false `prefix_changed` after a credential or effort
  switch. A later host event with the same facts can replace the wire
  watcher: `research/team/walter/2026-11-18-cache-anomaly-per-provider.md`.
- 2026-11-18: **`ma-acp-plugin` sends no notice for a diagnostic below warning
  severity** (`353ed8f`, `diag-notices.ts`), so the cache plugin's info
  `ttl_expired` stays out of the editor. The notice titles follow the new
  cache codes (`prefix_changed`: "Prompt cache not read").
- 2026-11-18: **Anthropic models declare whether they keep the thinking of
  earlier turns, and the opencode go/zen Anthropic builders apply the cap of 4
  `cache_control` markers** (`5ef298f`, Matthew). Part of the prompt-cache fix
  in core (`48721c3`), behind flags that are OFF by default, so requests are
  unchanged.
- 2026-11-18: **A replay harness and six scrubbed worker fixtures for the
  sub-agent lane view** (`0d6d56c`, `ma-sub-agents-plugin/lib/lane`, Frank).
  Test code only. The fixture scrub test matches the user name only as a path
  segment or before an `@` (`5061470`), because on a CI runner the user is
  `runner`, an ordinary word in four fixtures.

- 2026-11-18: **`ma-acp-plugin` sends the structured data of a tool result as
  `rawOutput`.** The last `tool_call_update` of a call now carries
  `rawOutput` when the tool outcome has `data` (core `tool_result` wire event,
  M3). It does so also for a failed call. A tool result with no `data` gives
  the same update as before. The plugin sets no size cap on `rawOutput`: core
  caps the stored data at 16000 bytes.

- 2026-11-18: **`ma-llm-cursor-plugin` reads the stored outcome of a tool
  result for the wire text, only where the bytes stay equal.**
  `toolResultToWireText` takes the body and the plain-text annotations
  (`[truncated: ...]`, `[note: ...]`) from the stored `outcome` (core
  `viewPersistedOutcome`), then runs the same strip regex as before. It uses
  this path only when the result is provably the same as the old path: the
  outcome fits, the only text block is the first one, the spans cover the
  text to its end, the body and the plain-text annotations hold no harness
  opener or closer (`<ma::agent::`, `</ma::agent::`, any letter case), and
  every tag annotation is removed completely by the strip step with no white
  space left. In every other case (no or bad outcome, a plugin annotation, a
  harness tag in the body, an edited text, a tasks board in the body) the old
  path runs. The text sent to Cursor is byte-equal to the old path: an
  in-repo differential test (a frozen copy of the old function, the
  adversarial inputs of the review, a 300-case grammar fuzz, and 5 MB and 1 MB
  bodies) and a reviewer fuzz of 300000 cases found no difference.

### Fixed

- 2026-11-18: **`ma-chrome-cdp-plugin` answers 503, not 400, when Chrome quits
  during a request, and the fetch watchdog test no longer uses a fake process
  id that could signal a real process group** (Frank).
- 2026-11-18: **OpenAI tools are sent as strict, with nullable optional
  properties** (`8de6c35`, Donald). The nulls of unused optional fields are
  dropped before the tool runs, so the model no longer invents `""`, `offset`
  or `timeout` values. `Task` `id`, `parent`, `after` and `order` accept a
  string or an integer. 53 request goldens change only in those four Task keys.

- 2026-11-18: **A target switch is visible to the model and in the
  footer.** Reported by Gaston: after `/provider` to an other credential,
  the model answered "nothing changed", and the footer showed an old effort.
  - `ma-session-info-plugin`: the model now gets one line at its next turn
    (`turn.willStart` context) that names each value that a switch changed
    (`/provider`, `/credential-name`, `/model`, `/effort`; event
    `target.didSwitch`). Several switches before one turn give one line,
    from the first to the last target; a switch there and back gives none.
    The line has names only (credential name, provider id, model id,
    effort), no secret.
  - `SessionInfo` shows the credential of the live target on a
    `Credential:` line, and takes the effort from the live target
    (`ctx.queryTarget`) instead of the env copy.
  - `ma-quota-status-plugin`: the footer reads the effort at each draw (it
    read it once at load, so it kept the boot effort), and it draws again on
    `target.didSwitch` (it waited for the next model response).

- 2026-11-15: **`ma-llm-openai-plugin` removes citation markers from the
  answer text.** OpenAI models write a marker made of the private-use
  characters U+E200, U+E202 and U+E201 around `cite` and references like
  `turn0search0`. With a custom search tool nothing resolves it, so the user
  saw unprintable glyphs and `citeturn0search0`. The Responses path of the
  adapter now runs `stripCitationMarkers` on the canonical events. It drops
  only a well-formed marker, also when the marker is split across deltas, and
  it leaves thinking and tool input unchanged. The strip runs after the
  network client, so the net-dbg capture keeps the raw bytes.

- 2026-11-01 `c19b4ad`: **Responses usage counts cached tokens once.** Core
  now treats canonical `inputTokens` as uncached input only. The Responses
  `input_tokens` field includes `input_tokens_details.cached_tokens`. So the
  five Responses adapters (openai, grok, meta, opencode-go, opencode-zen)
  counted cached tokens twice, in `used` and in cost. They now subtract them.
  Each adapter has a golden usage test.

- 2026-11-01 `79013c1`: **`ma-acp-plugin` sends no `config_option_update`
  for a client config change.** `session/set_config_option` answers with the
  complete option list, with the new value selected. The ACP spec keeps
  `config_option_update` for changes the agent makes itself (for example
  `model_adopted`). This removes the push that `2673aab` added.

- 2026-11-01 `2673aab`: **`ma-acp-plugin` accepts a symlinked cwd on
  `session/new`.** The check compared paths as plain strings. On macOS,
  `/var/folders/...` is a symlink to `/private/var/...`, so `session/new` gave
  `-32602`. The check now compares real paths.

- 2026-11-01: **`ma-llm-anthropic-plugin` keeps thinking blocks after a model
  switch, with no ask.** The adapter had a preflight check that asked the user
  and offered "strip" as the default. The API docs say to send thinking blocks
  back unchanged, also after a model switch. Remove the check
  (`thinking-preflight.ts`, its exports and its tests). The adapter now has no
  `preflight()` and no `applyResolution()`. Re-pin core to `29d279c`. Core now
  scopes the preflight model lookup to the session provider.

- 2026-10-31: **Biome pinned to `2.5.15` in the catalog.** `bun.lock` is
  gitignored here, so the old `^2.5.15` range let every fresh install take the
  newest Biome. Biome 2.6.4 formats Markdown code blocks and failed
  `format:check` on 20 plugin `.md` files that 2.5.15 accepts. Core's lockfile
  already pins 2.5.15. Bump the pin on purpose, together with a reformat.

### Added

- 2026-11-17: **`ma-acp-plugin` tells the client about a retry or quota
  wait, and names what a target switch changed.**
  - A wait. The encoder sent nothing for the `status` phases `retrying` and
    `waiting_for_quota`, so an ACP client showed nothing while the session
    waited, also for hours. Now a wait of 10 seconds or more gives one
    notice (or its text fallback): the cause code, the time to the next try
    as a duration, the reset time when core has it, the number of the next
    try, and "To continue now, change the provider or the model." A shorter wait gives
    nothing. A retry wait of one minute or more is a `warning`. After the
    first retry notice of a prompt, only a wait of one minute or more gives
    one more. All rules and text are in the new `wait-notice.ts`; the
    encoder calls one function. No new ACP method and no `_meta` key.
  - A switch. The notice of a target switch now names each changed value in
    the order credential, provider, model, effort, for example `[target]
    Changed credential to "second" (was "full")`. The title is "Credential
    changed", "Provider changed", "Model changed", "Effort changed", or
    "Target changed" for two or more. Before, a credential-only switch said
    `Adopted model "m" (was "m")`. This needs the `fromTarget` and
    `toTarget` fields of core; with an older core, and for an automatic
    model adoption, the text is the same as before.
  - The words of the wait notice are not the words of the TUI status row
    for the same wait ("Retrying after ... — sleeping Ns"). The STE gate of
    this repository reads each `description:` literal and does not accept
    "waiting", "reset", "attempt" or "retrying" there. The notice has the
    same facts: the cause code, the wait, and the number of the next try.
  - A 429 with `Retry-After` is the phase `retrying`, not
    `waiting_for_quota` (core `sdk/run-recovery.ts`). So the two phases get
    the same treatment, and the wait time decides the severity of a retry.
  - Not tested: a real client during a real wait of hours (the tests use a
    mock endpoint with `Retry-After: 3600` and end the wait with a switch
    after less than a second); a switch of the `provider` or `effort`
    option during a wait in the real-process test (only `model`); an older
    plugin with the newer core (by reading: it ignores the two new fields).
    There is no update when a wait ends with no switch: the next update of
    the prompt follows it.

- 2026-11-17: **`ma-sub-agents-plugin`: a RUNNING worker follows a target
  switch of its lead, in place.** When the lead switches its credential,
  provider, model or effort, the plugin (event `target.didSwitch`) appends
  one signed line to `<sessionsDir>/<childSid>.control.jsonl` for each
  running worker. The worker's CLI reads it and switches its own core, so
  it keeps its process, its history and its work, and a worker in a quota
  wait continues at once. A worker that the user put on a different
  credential or provider does not follow.
  - Each worker gets its own key at spawn (HMAC of a lead secret that is
    in memory only). A line needs a correct mac, the lead's session id and
    a newer sequence number. It has no token, key or endpoint.
  - Any tool can put a file at the control path first. The lead's open
    does not block and does not follow a symlink, and it writes only to a
    regular file of this user, which gets mode 0600 (also a file that was
    there with a wider mode). A FIFO, a symlink or a directory at the path
    counts as a failed write for that worker; the other workers get their
    line.
  - After a lead restart, the workers of the earlier lead process cannot
    be reached. The plugin says how many keep their old target.
  - Limit: this stops a one-step "append a line to this file" instruction.
    It does not stop a process that already runs commands as the same user.

- 2026-11-17: **A target switch during the session.** Follows core
  `feat/target-switch-anytime`.
  - `ma-sub-agents-plugin`: a new worker gets the lead's live credential,
    provider and effort (`ctx.queryTarget`). Before, it got the values of
    the lead's boot, so after a switch it had the new model with the old
    credential. A host with no `queryTarget` keeps the env and argv sources.
  - `ma-acp-plugin`: `session/set_config_option` during a retry or quota
    wait now takes effect at once. The same prompt continues on the new
    target, with no cancel (e2e test k2).
  - `ma-llm-anthropic-plugin`: the thinking-switch test has the new rule.
    No thinking block of the old target goes to the new one.
  - `ma-session-history-plugin`: a summary line for the `target_switch`
    record.

- 2026-11-02 `b592d92`: **`ma-llm-anthropic-plugin` reads plan, seat, and
  usage for a stored credential.** New `account-plan.ts` gives the provider a
  `fetchAccountPlan` hook. It reads `GET /api/oauth/profile`,
  `/api/oauth/claude_cli/roles`, and `/api/oauth/usage`. It makes no
  inference call, so it spends no model quota. An API key resolves `null`.
  The roles and usage calls are optional. A failed profile call rejects.
  `rate_limit_tier` tells seats apart: `default_raven` is a Team member with
  no seat, `default_claude_max_<n>x` is a seat or a personal Max plan. An
  unknown tier shows raw and leaves `hasPlan` unset. The contract types are
  mirrored locally until the core pin has the hook.

- 2026-11-01 `098dec4`: **Live model catalogs refreshed for five
  providers.** Each new id has pricing and capabilities.
  - Anthropic: `claude-sonnet-5-5` and `claude-haiku-5-5`, each with a
    `[1m]` alias. Haiku 5.5 joins the 1M context families in
    `list-models.ts`.
  - OpenAI: `gpt-6.1-terra` (Responses) and `gpt-6.1-terra-chat`.
  - Cursor: static catalog goes from 375 to 443 rows (68 new ids), from the
    2026-11-01 AvailableModels probe.
  - OpenCode Zen: adds `gemini-4-argon`, `muse-wonder-1.0`,
    `deepseek-v4.1-flash-free`, `glm-5.3-flash-free`, `beam-free`,
    `flint-40b-free`, and `nemotron-3.5-super-vl-free`. `LIVE_MODEL_IDS` goes
    from 82 to 78.
  - OpenCode Go: adds `beam-free`, `gemini-4-argon`,
    `iceman-contributor-free`, `kimi-k3.1-pro`, `minimax-m3.1-flash`, and
    `step-5-preview` (Chat).

- 2026-11-01 `2673aab`: **`ma-acp-plugin` `--approval-timeout-ms`.** A
  host-mode argument (`--approval-timeout-ms <n>` or `=<n>`) sets the
  approval gate deadline. The default stays 10 minutes. A value that is not
  a positive integer is a startup error: a stderr message, no stdout, exit
  code 2. See [`ma-acp-plugin/README.md`](ma-acp-plugin/README.md).

- 2026-11-01 `8b353f8`: **`bun run pin:core` and a core pin guard.**
  `scripts/pin-core.ts` sets one core SHA in every `package.json` dependency
  field, shows `old -> new` per file, and runs `bun install`. With no SHA it
  uses core `main`. `scripts/core-pin.test.ts` (part of `bun run check`)
  fails when a `package.json` or `bun.lock` core ref differs from the root
  pin or is not a full 40-char SHA. See [`AGENTS.md`](AGENTS.md).

- 2026-10-31: **`ma-acp-plugin` session/update encoder.** New modules
  `encoder.ts`, `stop-reason.ts`, `notices.ts`, `config-options.ts`, wired
  into `host-mode.ts`. ACP stop-reason refinement on top of core's
  `deriveStopCause` (pause_turn, context_window_exceeded, completed-turn
  error; never `max_turn_requests`). Core notices map `warn` to `warning`
  and go out as `notice` only when the client advertised `session.notices`,
  else as an `agent_message_chunk`. `usage_update` sends `used` (last turn's
  input + cache tokens, a proxy) and `size` (the model's context window).
  `configOptions` for model (same provider) and effort (left out when the
  model has none), `session/set_config_option`, and a
  `config_option_update` push on every `model_adopted` notice. Tool updates
  carry an ACP `kind`, `status`, and file `locations`.

- 2026-10-14: **OpenCode Go and Zen catalogs refreshed (live `/v1/models`
  2026-10-11).** Go adds `claude-haiku-5-5` (Messages), `gpt-6-luna` and
  `grok-4.7` (Responses), and `longcat-2.5-preview-free`, `mimo-v2.6-flash`,
  `mimo-v2.6-pro`, `space-bunny`, `step-5-preview-free` (Chat). Zen
  `LIVE_MODEL_IDS` goes from 64 to 82. Pricing comes from docs/go first, then
  models.dev. Coverage in each package's `opencode.test.ts`.

### Removed

- 2026-11-01 `098dec4`: **More OpenCode ids gone from the live catalogs.**
  Zen drops `gemini-3.1-pro`, `gemini-3-flash`, `deepseek-v4-flash`,
  `jev-1.13`, `jev-1.13-free`, `step-5-preview-free`, `space-bunny-free`,
  `longcat-2.5-preview-free`, `ling-3.1-flash-free`,
  `muse-spark-1.3-contributor-free`, and `muse-spark-1.2-contributor-free`.
  Go drops `deepseek-flash`, `deepseek-v4-flash`,
  `deepseek-v4-flash-vision-exp`, `glm-5.1`, `kimi-k2.6`,
  `longcat-2.5-preview-free`, `omen-alpha`, `mimo-v2.5`, `mimo-v2.5-pro`,
  `space-bunny`, `step-5-preview-free`, `grok-4.6`, `minimax-m2.7`,
  `minimax-m2.5`, `qwen3.7-max`, and `qwen3.6-plus`. Their `CAPS_*` and
  `PRICING_*` exports are gone too. A saved config or `--model` that names
  one of these no longer resolves under that provider.

- 2026-11-01 `4734d3a`: **Vendored terminal helpers and tool chrome keys.**
  `ma-config-plugin` and `ma-usage-plugin` drop their `lib/term-width.ts`
  copies, and `ma-config-plugin` drops `lib/ansi.ts`. Tool manifests drop
  `icon`, `color`, and `headerKey`. The CLI presentation map holds them now.

- 2026-10-14: **OpenCode ids gone from the live catalogs.** Go drops `glm-5`,
  `kimi-k2.5`, `grok-4.5`, `hy3-preview`, `mimo-v2-pro`, `mimo-v2-omni`, and
  `qwen3.5-plus`. Zen drops `claude-sonnet-4`, `x-preview-f-free`,
  `deepseek-v4-flash-free`, `mimo-v2.5-free`, `hy3-free`,
  `nemotron-3-ultra-free`, and `laguna-s-2.1-free`. A saved config or
  `--model` that names one of these no longer resolves under that provider.

### Changed

- 2026-11-01 `4734d3a`: **Terminal styles move to `ui/setup.ts` modules
  (S41).** Headless plugin code reads display styles from plain style slots
  (`lib/style.ts` or `lib/style-slots.ts`). Each slot is plain text until the
  CLI runs the plugin's `ui/setup.ts` (manifest `ui.setup`), which installs
  the CLI terminal kit. Strip sites use the core `stripAnsi`.
  `ma-quota-status-plugin` code moves to `ui/`. New headless-bytes golden
  tests pin the model bytes of `ma-skills-plugin` and `ma-fetch-plugin`.

- 2026-11-01 `7dec392`: **Every manifest splits into `headless` and `ui`
  blocks (S31).** Core loads only the `headless` block. The CLI loads the
  `ui` block. Tools (was `tuis`) and every other contribution move into
  `headless`. `liveAreaSlots` move into `ui.liveAreaSlots`.

- 2026-11-01 `2728cb3`: **Core pinned to `b8c8c21` in every package.** The
  pin moved through `61b4fa2`, `8791f27`, `0528dae`, `69b9352`, `e44a201`, and
  `a24be3a` in this range. Core no longer holds the Anthropic plan OAuth
  client (decision 39). `ma-llm-anthropic-plugin` now owns it and claims the
  same store key, so a stored login still works.

- 2026-10-14: **Model-facing plugin prose follows the writing-style rules.**
  PROMPT.md files, manifest descriptions, tool result and error strings in
  about 30 plugins, the identity fragment, env-info `gather.sh`, and
  `result-protocol.tmpl.md` drop semicolons, em dashes, unicode arrows,
  ellipses, warning glyphs, and filler words. Stream translators now format
  error `cause` as `X: msg` (it was `X — msg`). No other behavior change.
  `scripts/prompt-audit.test.ts` masks code and URLs, reads only manifest
  `description` values, and enforces no semicolons, no emoji, no sycophancy
  or signposting, and no `---` before a heading. Work by Edward (`7ec3d118`).

- 2026-10-04: **`ma-llm-meta-plugin` is Responses-primary for Muse Spark.** Bare
  ids (`muse-spark-1.3` default, `1.2`, `1.1`, contributors) use
  `openai-responses` with Chat companions (`*-chat`). Defaults: `store:false`,
  `include:["reasoning.encrypted_content"]`, drop `previous_response_id` unless
  store is true. `prompt_cache_key` from vendor / `metadata.sessionId`, then
  `ctx.sessionId` fallback (OpenAI parity). Catalog refreshed for live
  `muse-spark-1.3` (+ contributor). Effort: Standard 1.3 includes `max`;
  Contributor omits it. Offline: `bun test` in the package 26 pass. Live:
  encrypted Responses + key on wire with Muse Code OAuth. See
  [`ma-llm-meta-plugin/README.md`](ma-llm-meta-plugin/README.md) and
  [`ma-llm-meta-plugin/docs/prompt-cache.md`](ma-llm-meta-plugin/docs/prompt-cache.md).

- 2026-10-04: **`ma-diagnostics-plugin` checks PHP syntax and Laravel Pint style
  after Edit/Write.** Detects PATH `php` for `php -l` (type gate) and
  `vendor/bin/pint` or PATH `pint` for check-only
  `pint --test --format=json -v -- <file>` (format gate). Activates on
  Composer/Laravel roots (`composer.json` / `artisan`, plus `pint.json` or a
  `laravel/pint` dep for Pint). No PHP/Pint version pins: the project binary
  wins. Exit 1 from Pint is treated as findings, not a runner failure. See
  [`ma-diagnostics-plugin/docs/php-linting.md`](ma-diagnostics-plugin/docs/php-linting.md).

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

- 2026-10-04: **`ma-skills-plugin` caps only the Level-1 prompt catalog.**
  `plugins["ma-skills"].maxSkills` (default 64) still bounds the system-prompt
  table. `Skill list` / `info` / `read` scan every valid pack. Overflow emits one
  `ctx.log.warn("skill-catalog", ...)` and a short fragment note. Broken SKILL.md
  files still warn via `skill-load`.

- 2026-10-04: **`ma-skills-plugin` warns through the host logger when a SKILL.md
  fails to load.** Boot discovery still skips the broken pack. It now calls
  `ctx.log.warn("skill-load", ...)` once per failure (name + first parse error +
  structured `dir`/`scope`/`reason`). Core owns the TUI last-warn slot. The
  plugin does not write stderr or extra ANSI for this. The catalog fragment and
  `Skill list` still list broken skills for the model.

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

- 2026-10-10: **Quota footer identity no longer gets ellipsis-cut at full terminal width.** The host live area paints every footer row at `cols - 1` (wrap-safety clamp). The quota renderer budgeted the full `COLUMNS`, so the bar ladder kept wide bars and the editor then cut the trailing session name. `footerReservedWidth` now always includes that wrap cell (plus suffix and tails). The handler subtracts `max(1, reserve)` so an older host that reports `0` or omits the field still shrinks by one cell. Regression: 111-col two-window footer keeps the sid and name with leaner bars.

- 2026-10-04: **Prompt cache behavior documented per provider.** Work by Matthew (`68a0d8fb`) with Jonathan (`b63d615f`) and Donna (`fcc46867`).
  - Meta: automatic prefix KV cache, no `cache_control`. Responses maps `input_tokens_details.cached_tokens`. Live session hit 29.5 percent. `prompt_cache_key` is sent. `prompt_cache_retention` is declared but NOT wired on meta Responses (OpenAI sibling does wire it). Doc updated. See [`ma-llm-meta-plugin/docs/prompt-cache.md`](ma-llm-meta-plugin/docs/prompt-cache.md).
  - OpenAI: automatic prefix cache, routing keys only. One live hit at 63 percent then drop on prefix churn. See [`ma-llm-openai-plugin/docs/prompt-cache.md`](ma-llm-openai-plugin/docs/prompt-cache.md).
  - Cursor: reports no cache counters. Wire can carry `cache_read` at 79 percent but mapper drops it. `cursor-auto` rejects effort flags. See [`ma-llm-cursor-plugin/docs/prompt-cache.md`](ma-llm-cursor-plugin/docs/prompt-cache.md).
  - Grok: sticky `prompt_cache_key` routing, reads `cached_tokens`, create stays empty. No live data: quota dead plus 3 creds dead. See [`ma-llm-grok-plugin/docs/prompt-cache.md`](ma-llm-grok-plugin/docs/prompt-cache.md).
  - Full probes: `research/2026-10-04-subagent-bugs/findings.md`.

- 2026-10-04: **Sub-agent fleet token count is last-turn contextSize, not a
  billed integral.** Work by Donna (`fcc46867`) with Matthew (`68a0d8fb`).
  - Before: `parseProgress` did `tokens += input + output` on every assistant
    turn. On Cursor, `input_tokens` is checkpoint `used_tokens` (absolute
    conversation size, output always 0), so 7 tools in ~47s showed `248k`
    (`247833`) while the window was `36718`. A 48-tool explorer showed `2.76M`
    with last context `90724`. Net-dbg on that A5 worker had **one**
    `AgentService/Run`, so the UI was not counting 7 prefills.
  - After: `tokens = input + cacheRead + cacheCreate`, replaced each turn with
    `usage`. Matches host `session-tokens.ts` `contextSize`. Fleet footer still
    sums those last footprints across workers (concurrent windows).
  - Meta/OpenAI still report per-turn prefill plus `cached_tokens`. The old sum
    was closer to billed work there and still not footprint (Matthew:
    lead last window ~98k with ~69k cache read, widget factor ~4-5).
  - Not in this patch: billed growth sum, cache overspend, Cursor usage mapping,
    tokens on stopped/failed handles, extra Runs after bidi drop.
  - Tests: `ma-sub-agents-plugin` `bun test` 293 pass, 0 fail.
  - Write-up:
    [`ma-sub-agents-plugin/docs/fleet-token-count.md`](ma-sub-agents-plugin/docs/fleet-token-count.md).

- 2026-10-04: **Quota footer keeps session id and name while shrinking bars.**
  Squeeze order now shortens separators and effort, then shrinks bars 8 to 4
  cells with `withSid: true`, and only drops sid/name after `BAR_CELLS_MIN`.
  Identity stays visible longer under tight host TPS budgets.
  - Code: `ma-quota-status-plugin/render.ts`.
  - Tests: `ma-quota-status-plugin/render.test.ts`.

- 2026-10-04 14:18:57 -0400: **Cursor MCP bridge and history fold no longer
  break tool calls.** Work by George (`3c3002a8`).
  - `CallDynamicTool` is a real server bridge, not a missing MA tool. Structured
    calls unwrap to a registered target after namespace, name, and argument
    checks. Recursive wrappers and unknown targets fail on the wire. Assistant
    prose that looks like a tool call is never executed.
  - Advertised MCP targets are validated against their schemas before host
    dispatch (example: Task `{id:"6a"}` without `action`). Read still accepts
    `path` as an alias for `file_path`. Custom tools get no inferred aliases.
  - When conversation carry is absent, folded history labels past tool_use and
    tool_result as non-executable data. Fake `CallDynamicToolnamespace...`
    assistant text is stripped. The latest user text is kept.
  - The GetDynamicTools catalog still prints full schemas. The catalog prompt
    states that the server bridge exists and still prefers direct MA names.
  - Coverage in `mcp-contract.test.ts` and `bidi-unregistered-mcp.test.ts`.
    Offline: `bun run check` exit 0. Live E2E still skipped without `E2E=1`.

- 2026-10-04: **Cursor raw response streams are saved when network debugging is
  enabled.** Removed the provider's response-capture veto in both bidi and unary
  paths. `MINIMAL_AGENT_NET_DBG=1` now records the original binary Connect frames
  in `*-04-res-body.txt`, allowing inspection of discovery, tool, checkpoint and
  KV events that are absent from the transcript. Logging still follows the host
  debug flag.

- 2026-10-03: **Cursor tool discovery now returns full input schemas and
  descriptions.** The earlier `GetDynamicTools` bridge fix returned only short
  name/description rows, so asking for schemas still left the model guessing
  Read's `file_path`, Task's `id` and string children, and subagents' `task`.
  Both discovery and unknown-tool recovery now include the exact registered
  JSON schemas and complete descriptions. Offline regression coverage checks
  the actual bidi MCP result. See
  [`tool-discovery-schema-postmortem.md`](ma-llm-cursor-plugin/docs/tool-discovery-schema-postmortem.md).

- 2026-10-01: **Cursor calls to the GetDynamicTools bridge no longer end in
  "Unknown tool".** The allowlist keeps `get_mcp_tools_tool_call` on, so the
  server shows the model its GetDynamicTools / CallDynamicTool bridge, and the
  model sometimes calls those names. They arrive as MCP execs for a tool MA
  never registered, and the host answered "Unknown tool". The plugin now
  answers them on the wire (`mcp-exec-guard.ts`): GetDynamicTools gets the real
  MA tool list, and any other unknown name gets an error plus the list, so the
  model calls the real tool next. Coverage in `bidi-unregistered-mcp.test.ts`.

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
- Update 2026-10-01: MA now carries Cursor `conversation_state` and checkpoints
  across fresh Runs (see Fixed, "fake tool calls as text"). Whether Cursor
  server-side auto-compaction now applies to MA sessions is not yet measured.
  Original note: MA did not send Cursor `conversation_state` or store
  checkpoints, so Cursor server-side auto-compaction never applied. Cursor staff
  have said it starts at about 90% of the window (forum post, cited in the CLI
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
