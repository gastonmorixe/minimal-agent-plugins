# ma-sub-agents-plugin

Delegation for minimal-agent. The lead agent spawns background **workers**,
watches them in a live fleet widget, and gets each worker's result back
between turns. A worker is a real headless `minimal-agent` process with its
own session id, so it can use every tool the lead can use, on its own context
window.

```
◈ fleet 3f2a · ◐ 2 · ✔ 1 · ✘ 0 · ctx 61.3k · out 2.8k
   ◑ A1  explorer   1m12  Bash: rg -n "parseArgs" src (0m04) · 9 tools · ctx 30.9k · out 812
   ◐ A2  worker     0m31  ✎ The fix moves the guard into… · 4 tools ✘1 · ctx 22.4k · out 340
   ✔ A3  reviewer   done  No blocking issues; 2 nits in… → AgentResult A3
```

Disable the whole plugin with `MINIMAL_AGENT_DISABLE_SUBAGENTS=1`.

## Tools

The host adds the plugin prefix, so the model sees the tools as
`SubAgentsSpawnAgent`, `SubAgentsListAgents`, and so on.

| Tool           | Who calls it | What it does                                                                                      |
| -------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| `SpawnAgent`   | lead         | Starts a worker. Returns its handle (`A1`, `A2`, …), label and isolation tier.                    |
| `ListAgents`   | lead         | The whole fleet, one line per worker.                                                             |
| `AgentStatus`  | lead         | One worker in detail: model, status, what it is doing now, session id, task.                      |
| `AgentOutput`  | lead         | A bounded tail of a worker's recent activity: tool calls, failed calls, notices, live text.       |
| `AgentResult`  | lead         | The distilled deliverable of a finished worker. The only worker content that enters lead context. |
| `StopAgent`    | lead         | Cancels a worker and kills its process.                                                           |
| `Mailbox`      | both         | Opt-in notes between the lead and its workers (claim a file, flag a blocker, hand off a finding). |
| `ReportResult` | worker       | The worker's last act: hands back `summary`, `artifacts`, `incomplete`, and `deliverables`.       |

`ReportResult` is available only inside a worker (it needs the result path the
lead puts in the worker's env).

When the lead sets `expectArtifacts`, the spawn puts the list in the worker env
(`MINIMAL_AGENT_SUBAGENT_EXPECT_ARTIFACTS`, a JSON array) and in the prompt. The
worker passes each file in `ReportResult.deliverables` (`{ path, content }`) and
the handler writes it. This works in every mode, also read-only `ask`. A path
outside the list is refused. While a listed file is missing or empty,
`ReportResult` returns an error and records nothing, unless `incomplete` is true.

A read-only worker can write exactly the paths the lead lists in
`expectArtifacts`, anywhere on disk. There is no cwd limit: the lead owns that
list. The handler writes all files as temp files first and renames them only
when every temp write succeeds. It refuses a path that is a symlink, a path
with a trailing slash, and a path given twice. A required file counts as
present only when it is a regular file with at least one byte, in the handler
and in the supervisor probe.

### `SpawnAgent` parameters

| Parameter         | Meaning                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `task`            | Required. The objective, the file boundaries, and the exact output wanted back.                                               |
| `agent`           | A built-in specialist (see below). Omit it to use `system`.                                                                   |
| `system`          | An inline role prompt, used when `agent` is omitted.                                                                          |
| `model`           | A model id. Default: the lead's own current model.                                                                            |
| `effort`          | Reasoning effort. Default: unset, so the model's own default applies.                                                         |
| `isolation`       | `fresh` (default): a clean context. `fork`: the worker resumes a fork of the lead's conversation and shares its prompt cache. |
| `label`           | Display name in the widget. Default: the agent type.                                                                          |
| `taskId`          | A Task-tool id. The supervisor ticks it done on success, or cancels it with a reason otherwise.                               |
| `expectArtifacts` | Absolute paths the worker must produce. A relative path is refused. A missing or empty path makes the worker `incomplete`.    |
| `budget`          | `{ deadlineSec, maxTurns, maxTokens }`. See [Budgets](#budgets). Without `deadlineSec`, a hard 30-minute deadline applies.    |

### Budgets

The supervisor checks each limit once per tick (1 s) and stops a worker that
is past one. The worker ends `failed` with the reason, for example
`budget exceeded: started turn 4 with maxTurns 3`.

| Field         | Counts                                                                        |
| ------------- | ----------------------------------------------------------------------------- |
| `deadlineSec` | Wall-clock seconds since spawn.                                               |
| `maxTurns`    | Model responses. The worker gets `maxTurns` turns and is stopped on the next. |
| `maxTokens`   | Generated tokens (output, thinking included) summed over the run.             |

`maxTokens` counts output, not context size, because context re-counts the
same prefix every turn. `maxTurns` and `maxTokens` read the worker's event
stream, so they do not apply to a worker launched before streams existed, and
`maxTokens` cannot trip on a provider that reports no output tokens. A limit
can overshoot by what the worker does within one tick. A worker that already
called `ReportResult`, or whose run already ended, is never stopped for its
budget.

## Specialists

| `agent`      | Role     | Isolation | Write access | Use it for                                              |
| ------------ | -------- | --------- | ------------ | ------------------------------------------------------- |
| `explorer`   | scout    | fresh     | read-only    | Finding the few files and lines that answer a question. |
| `planner`    | balanced | fork      | read-only    | A numbered plan with files and a validation command.    |
| `worker`     | balanced | fresh     | yes          | Implementing exactly the delegated change.              |
| `reviewer`   | deep     | fresh     | read-only    | A strict review of the current diff.                    |
| `integrator` | balanced | fresh     | yes          | Running the gate and owning git for a wave of work.     |
| `log-miner`  | deep     | fresh     | read-only    | Forensics over large, noisy logs and data files.        |

"Read-only" is enforced, not just requested: these workers run with
`--mode ask`, so Edit and Write are denied when the tool is called.

The role does **not** pick a model by default. Every worker inherits the
lead's model, so delegating never silently downgrades it. Set
`MINIMAL_AGENT_SUBAGENT_AUTO_TIER=1` to map roles to provider-picked models
(scout cheap, deep flagship). An explicit `model` and
`MINIMAL_AGENT_SUBAGENT_MODEL` always win.

## How a worker runs

```
SpawnAgent ──▶ guard ──▶ subagent.willSpawn ──▶ launch child ──▶ running
                                                                   │  1 s supervisor tick
                                                                   ▼
                                 done · incomplete · failed · stopped ──▶ digest injected into the lead
```

1. **Guard.** The plugin checks its own caps (depth, concurrency, lifetime
   total). Then any bus listener on the `subagent.willSpawn` chain can veto
   the spawn. A refusal is a teaching message the model reads.
2. **Launch.** The child is started as:

   ```sh
   minimal-agent [--resume <leadSid>] --session-id <childSid> --no-header \
     --mode <none|ask> --output-format stream-json \
     [--model … --provider … --effort … --credential-name …] --prompt "<prompt>"
   ```

   The prompt is the specialist preamble, the task, and the result protocol
   (`prompts/result-protocol.tmpl.md`). The `intercom` plugin is always
   disabled in workers. They talk to the lead over `Mailbox`.

3. **Supervise.** A live-area slot runs the supervisor every second. Its
   probe reads the worker's event stream, its result sentinel and its
   artifacts. A pure reducer (`lib/supervisor.ts`) decides the next state, and
   a thin shell runs the effects: persist, emit, inject, kill.
4. **Report back.** When a worker ends, the lead gets a one-line digest
   between turns, for example
   `Sub-agent A1 (explorer) finished (2m14 · 9 tools, 1 failed · 4 turns): …`.
   The full text stays behind `AgentResult`, so it costs lead context only
   when the lead asks for it.

### End states

| Status       | When                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `done`       | The worker called `ReportResult`, or it ended cleanly and its final answer was recovered. A recovered answer is marked as best-effort.                |
| `incomplete` | It reported `incomplete: true`, a contracted artifact is missing or empty, or it exited with nothing. Any summary it wrote is kept for `AgentResult`. |
| `failed`     | Its event stream reported a failed or aborted run, it exited non-zero, it crashed at boot, or it passed its deadline.                                 |
| `stopped`    | The lead called `StopAgent`, or the lead shut down.                                                                                                   |

Precedence: a `ReportResult` sentinel wins over everything else. A failure
reported by the stream wins over partial final text, so a run that died
mid-way is `failed`, not `done` with half an answer.

## Event stream telemetry

Workers run with `--output-format stream-json`. Their stdout is a typed JSONL
protocol, not a log:

```
session_started → (turn_started · item_started · text_delta · tool_result · turn_completed)* → run_finished → result
```

`lib/stream.ts` folds it into a running state. It reads only the bytes added
since the last tick, so a long worker does not get slower to probe. From it
the supervisor gets:

- the model and provider the worker actually resolved,
- turns, tool calls, failed tool calls, and token usage per turn,
- the phase right now: `starting`, `thinking`, `writing`, `tool`, `waiting`,
  `finished`, plus the tool in flight and since when,
- the text being written (from `text_delta`),
- a definite end of run, the exact final answer (`result.text`), and the run
  duration,
- the real failure cause (`error.message` and `hint`). The CLI writes
  `error` + `run_finished(failed)` even when a worker fails at boot, for
  example on an unsupported effort level.

Two behaviors follow from it:

- **A run that ended is finalized at once.** If the stream wrote its final
  line but the process lingers (an open child process, a slow flush), the
  worker is finalized and its pid stopped. It does not hold a slot until the
  deadline.
- **A quiet worker is flagged.** The widget shows `idle 1m30` when no event
  arrived for 60 seconds and no tool call is in flight. A long tool call is
  not flagged.

Protocol stdio mode also means workers start no markdown formatter and write
no human chrome. Their stderr log stays empty unless something goes wrong.

Workers started before this change have no stream file. For them the probe
falls back to parsing the session transcript and searching the log for crash
lines.

## Files

All paths are under `~/.minimal-agent/sessions/` (`MINIMAL_AGENT_HOME`
moves the root).

| File                        | Owner  | Contents                                                                         |
| --------------------------- | ------ | -------------------------------------------------------------------------------- |
| `<leadSid>.subagents.jsonl` | lead   | The fleet: one record per worker, append-only. The supervisor's source of truth. |
| `<leadSid>.mailbox.jsonl`   | both   | `Mailbox` messages.                                                              |
| `<sid>.jsonl`               | worker | The worker's own session transcript.                                             |
| `<sid>.stream.ndjson`       | worker | The worker's stdout: its stream-json events.                                     |
| `<sid>.log`                 | worker | The worker's stderr.                                                             |
| `<sid>.result.json`         | worker | The result sentinel `ReportResult` writes.                                       |

The stream file is not named `.jsonl` on purpose: session scanners treat every
`*.jsonl` in this directory as a session transcript.

The supervisor also publishes presence rows (the lead and each worker) to
`~/.minimal-agent/presence/<leadSid>.jsonl`. Turn it off with
`MINIMAL_AGENT_SUBAGENT_NO_PRESENCE=1`.

## Lead awareness

- **Fleet attachment.** While any worker is active, a bounded
  `<ma::agent::subagents>` snapshot is attached to each turn. An idle fleet
  adds nothing.
- **Bus events.** Each end state emits `subagent.didReport` and
  `subagent.didExit` with `{ id, sid, status }`. A worker linked to a task also
  emits `subagent.taskUpdate`, which the tasks plugin applies.
- **Prompts.** `PROMPT.md` is the plugin's delegation discipline for the
  model. `prompts/leaf-discipline.md` is folded into every specialist.

## Cleanup

- `agent.willStop` in the lead SIGKILLs every worker that is still running or
  lingering after `ReportResult`.
- `agent.didStart` in a worker starts a **lead watch**. The worker exits with
  code 129 when its lead's pid is gone, or when it was reparented to pid 1.
  This covers a lead that was killed without running `agent.willStop`.

## Configuration

| Variable                                | Default      | Effect                                                                         |
| --------------------------------------- | ------------ | ------------------------------------------------------------------------------ |
| `MINIMAL_AGENT_DISABLE_SUBAGENTS`       | unset        | `1` turns the plugin off.                                                      |
| `MINIMAL_AGENT_SUBAGENT_MODEL`          | lead's model | Default worker model.                                                          |
| `MINIMAL_AGENT_SUBAGENT_AUTO_TIER`      | unset        | `1` maps specialist roles to provider-picked models.                           |
| `MINIMAL_AGENT_SUBAGENT_MAX_DEPTH`      | `1`          | Nesting depth. `1` means workers cannot spawn workers.                         |
| `MINIMAL_AGENT_SUBAGENT_MAX_CONCURRENT` | unlimited    | Active workers per lead.                                                       |
| `MINIMAL_AGENT_SUBAGENT_MAX_TOTAL`      | unlimited    | Spawns per lead session.                                                       |
| `MINIMAL_AGENT_SUBAGENT_TOKEN_BUDGET`   | `200000`     | Fleet token total above which the widget header turns gold. Advisory only.     |
| `MINIMAL_AGENT_SUBAGENT_NO_PRESENCE`    | unset        | `1` stops publishing presence rows.                                            |
| `MINIMAL_AGENT_BIN`                     | self         | The argv used to launch a worker (space-separated). Default: this same binary. |
| `MINIMAL_AGENT_LEAD_WATCH_MS`           | `2000`       | Poll interval of the worker-side lead watch, in ms (floor 50).                 |

The lead sets these for each worker. Do not set them by hand:
`MINIMAL_AGENT_SUBAGENT_DEPTH`, `MINIMAL_AGENT_SUBAGENT_LEAD`,
`MINIMAL_AGENT_SUBAGENT_ID`, `MINIMAL_AGENT_SUBAGENT_RESULT_PATH`,
`MINIMAL_AGENT_LEAD_PID`, `MINIMAL_AGENT_SUBAGENT_ROLE` (the agent type, or
`""` for an inline task; always set, so a parent role does not leak) and
`MINIMAL_AGENT_SUBAGENT_SID` (the child session id, the same value as
`--session-id`). `extraEnv` cannot change the role, the sid or the lead pid.
It also pins `MINIMAL_AGENT_MODEL`,
`MINIMAL_AGENT_PROVIDER` and `MINIMAL_AGENT_EFFORT` so the lead's values do not
leak into a worker that asked for something else.

## Layout

| Path                        | Role                                                                    |
| --------------------------- | ----------------------------------------------------------------------- |
| `lib/types.ts`              | Domain types: the status union, `Progress`, `ResultDigest`, the record. |
| `lib/service.ts`            | Spawn and stop: guard, policy chain, plan, launch, persist.             |
| `lib/spawn-plan.ts`         | Pure: builds the worker argv, env and prompt.                           |
| `lib/spawn.ts`              | Launch and probe IO, behind injected deps.                              |
| `lib/stream.ts`             | Pure stream-json parser plus the incremental reader.                    |
| `lib/supervisor.ts`         | Pure reducer: records + probes → next records + effects.                |
| `lib/supervisor-shell.ts`   | Runs one tick: probe, reduce, persist, effects, widget.                 |
| `lib/widget.ts`             | The live fleet widget.                                                  |
| `lib/content.ts`            | Model-facing text for the tool results.                                 |
| `lib/render.ts`             | Transcript tool-card rendering.                                         |
| `lib/library.ts`            | The built-in specialists.                                               |
| `lib/guard.ts`              | Spawn caps.                                                             |
| `lib/progress.ts`           | Transcript fallback: progress and final text from `<sid>.jsonl`.        |
| `lib/lead-watch.ts`         | Worker-side exit when the lead is gone.                                 |
| `lib/presence.ts`           | Presence rows.                                                          |
| `lib/mailbox.ts`            | The mailbox file.                                                       |
| `handlers/`                 | One file per tool and hook. `heartbeat.ts` drives the supervisor.       |
| `docs/fleet-token-count.md` | Why `tokens` is last-turn context size, not a billed sum.               |

## Tests

```sh
cd minimal-agent-plugins/ma-sub-agents-plugin
bun test                       # everything
bun test lib/stream.test.ts    # the stream parser and the stream-based probe
```

`lib/stream.test.ts` uses lines captured from real `--output-format
stream-json` runs, including a boot failure.
