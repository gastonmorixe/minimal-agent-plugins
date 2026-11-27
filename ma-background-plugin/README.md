# ma-background-plugin

A [minimal-agent][ma] plugin that lets the model run shell commands in the
**background**, check on them, read their output, and cancel them, without
blocking the conversation. Logs are durable and colocated with session history.

[ma]: https://github.com/gastonmorixe/minimal-agent-core

Four tools:

| Tool               | Purpose                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `BackgroundRun`    | Start a `bash -c` command in the background. Returns a handle (`j1`) and pid immediately, and the job runs concurrently. |
| `BackgroundStatus` | Cheap glance at one job or all jobs: state, elapsed, exit code, a short tail.                                            |
| `BackgroundLogs`   | The full read of a job's output: tail / line range / grep / `since` byte cursor, ANSI stripped by default.               |
| `BackgroundStop`   | Cancel one job or every running job. SIGTERM by default, escalates to SIGKILL.                                           |

This is "sub-agents for raw bash": it borrows the proven shapes from the
sub-agents plugin (Repository, discriminated-union state, a pure reducer plus an
imperative shell, injected dependencies, a once-a-second heartbeat slot) but
models a raw OS process, not an LLM worker.

## Why a background tool

The model already has full `Bash` and sub-agents, so it _can_ background work
today. But the foreground `Bash` tool is synchronous, and spawning a whole LLM
sub-agent just to run `bun test &` is the wrong tool. This plugin gives the model
a quick, obvious path: fire a command, get a handle back, keep working, and get a
digest between turns when it finishes.

## Architecture

```
ma-background-plugin/
├── manifest.json              4 tools (headless) + a 1s heartbeat slot (ui.liveAreaSlots)
├── bin/
│   └── runner.ts              The supervised per-job runner (the load-bearing process)
├── handlers/
│   ├── bg_run.ts              Validate → resolve timeout → start runner → return handle
│   ├── bg_status.ts           Reconcile → cheap glance (one job or all)
│   ├── bg_logs.ts             Bounded, parametrized read of the raw log
│   ├── bg_stop.ts             Cancel one job or all
│   └── heartbeat.ts           Live-area slot: reconcile + completion digest + widget
├── ui/
│   └── setup.ts               CLI only: installs the terminal kit into the style slots
└── lib/
    ├── host-types.ts          Local TUIContext / LiveAreaHandlerContext stubs
    ├── types.ts               Branded ids, Result, JobStatus discriminated union, JobRecord
    ├── duration.ts            "10m"/"2h"/"1d" → ms, clamp + infinite gate
    ├── paths.ts               Colocated session paths (<sid>.bgjobs.jsonl, <sid>.bgjobs/)
    ├── jsonc.ts               Tiny JSONC reader (zero-dep config)
    ├── config.ts              Reads plugins["ma-bg"] from ~/.minimal-agent/config.jsonc
    ├── sidecar.ts             The runner-owned <jobId>.status.json shape + parser
    ├── store.ts               BgJobStore (Repository over the index jsonl)
    ├── reconcile.ts           Pure reducer: probes → next records + effects
    ├── log-read.ts            Bounded tail/range/grep/since reads, ANSI strip
    ├── runner-core.ts         Pure runner logic (env contract, sidecar builders)
    ├── spawn.ts               Launch shell: detached runner with stdin pipe (injected)
    ├── registry.ts            In-process live-runner registry + parent-exit fan-out
    ├── service.ts             Service Layer: startJob + runReconcile
    ├── handler-deps.ts        Build real deps from a handler context
    ├── validate.ts            Tool input validation
    ├── style.ts               Style slots (plain until ui/setup.ts runs)
    └── render.ts              Transcript chrome (rich job blocks) + the breathing multi-line live panel
```

## What you see

Two surfaces, both designed so you always know what is running and how to reach it.

**The job block** (printed by `BackgroundRun` and `BackgroundStatus <id>`) shows
the command actually run, its live state, and the exact follow-up calls:

```
  ╭ ▶ BackgroundRun  j13 ● running · 0s · pid 4823 · 20:17:37
  │
  │ $ bun run build && ./install.sh && ./run-tvos.sh
  │ “Build + install + run tvOS on real Apple TV”
  │ ● running · 0s · pid 4823 · times out in 10m
  │ cwd ~/src/app
  │ log ~/.minimal-agent/sessions/<sid>.bgjobs/j13.log
  │ ▤ BackgroundLogs j13   ◎ BackgroundStatus j13   ■ BackgroundStop j13
  ╰
```

You get the command, the cwd, and the **log file path** so you can `tail -f` it in
another terminal in real time. A `BackgroundStatus <id>` on a job with output also
appends a short dim tail of its most recent lines.

**The live panel** (the footer) uses the same layout as the sub-agents fleet
widget. It shows one tree row for each background job, so the conversation never
hides what is running:

```
● Jobs · 2 running · 1 done
├ ● j13    0s Build + install + run tvOS on real Apple TV
├ ○ j14    3s bun test --coverage
├ ✔ j12   41s bun run lint
╰ ✔ 1 done · BackgroundStatus
```

The header dot and each running dot blink. Running jobs come first. Finished jobs
keep their rows. The `╰` summary row shows the finished counts, and `+N more` past
six jobs. No row is wider than the terminal. The panel has no rows when no job is
running.

## The hard requirement: jobs die with the harness

A background job must die when the agent exits, by any means including SIGKILL,
with no orphan left running. There is no in-process-only way to guarantee that
(SIGKILL runs no JavaScript), so the design uses three process layers:

```
harness handler  →  per-job detached runner (stdin: "pipe")  →  detached bash -c
```

The harness holds the runner's **stdin write end** open and never writes to it.
When the harness dies by any means, the OS closes that pipe, the runner sees
stdin EOF, group-kills the job (and its descendants), records the outcome, and
exits. The stdin-EOF link is fd-lifetime based, so it is independent of signals
and process groups: a `kill -9` on the agent still triggers it.

Defense in depth, layered:

1. **stdin EOF** is foolproof and survives a harness SIGKILL. This is the layer
   that must work. The rest are latency and robustness improvements.
2. **A graceful `process.on(exit|SIGINT|SIGTERM|SIGHUP)` fan-out** in the harness
   closes every pipe proactively on a normal quit (one shared listener, not one
   per job).
3. **A ppid poll** in the runner. If it gets reparented to init (ppid becomes 1)
   it self-terminates.
4. **Startup reconciliation**. On boot/resume, any `running` record whose runner
   pid is dead is marked `orphaned`, so the index never lies.

`bin/runner.integration.test.ts` proves the load-bearing case end to end. Closing
the runner's stdin kills the job and its grandchild.

### The whole job group dies with the job

The job runs in its own process group. When the job leader exits, by itself or
on a stop, the runner signals the rest of that group: SIGTERM, a 2 s grace, then
SIGKILL. The runner exits only when the group is empty (`kill(-pgid, 0)` gives
ESRCH) or SIGKILL was sent after the grace. The sidecar keeps the leader exit
code.

So a job like `server & echo started` no longer leaves `server` running after
the job ends. A process that must outlive its job has to leave the group. Linux
has a `setsid` command (`setsid server &`). macOS has no `setsid` on `PATH`, so
use the Perl form, which works on both:

```sh
perl -MPOSIX -e 'POSIX::setsid() or die "setsid: $!"; exec @ARGV' server &
```

`POSIX::setsid` calls the C `setsid()`
([perldoc POSIX](https://perldoc.perl.org/POSIX#setsid)), so `server` starts in
a new session and a new process group. The runner does not reach a process in
another group, so this is also an escape that this plugin does not catch.

The harness fan-out listens on SIGINT, SIGTERM, and SIGHUP. A listener on one of
these signals removes its default exit action
([Node.js signal events](https://nodejs.org/api/process.html#signal-events)).
ma-speak installs the same kind of fan-out. Each fan-out listener carries a
shared tag (`Symbol.for("minimal-agent.signal-fanout")`), and each one counts
only the listeners without the tag, before it runs its callbacks. When that
count is 0, the fan-out runs its callbacks, removes itself, and raises the
signal again. The next fan-out does the same, and after the last one the
default action ends the host. When an untagged listener exists (the CLI one
calls `process.exit`), the fan-out leaves the exit to that listener. The
fan-out runs once for each shutdown. The core file-lock signal listener is
also a fan-out listener (same tag). When it is the last listener, it removes
its locks and calls `process.exit` (130 for SIGINT, 143 for SIGTERM), so the
end is then that exit, not the default action.

## Headless runs: the turn waits for the jobs

A headless run (`-p`, `stream-json`, a sub-agent worker) has no live area, so
no digest comes between turns, and the process exits when the turn ends. Then
the runner kills each job. To prevent this, the `turn.willStop` hook
(`handlers/on_turn_will_stop.ts`, logic in `lib/headless-wait.ts`) acts only
when `ctx.run.interactive` is false and the mode is `one-shot`, `stream-json`
or `subagent` (not `host`). With no `ctx.run`, a worker id in the payload or
`MINIMAL_AGENT_WRAP_UP_TOOLS` marks a headless run. If jobs of the session
run, the hook polls the reconcile pass each second until they end, then halts
the stop with their digests. The model then gets one more round to read the
output. If the jobs were complete before the stop (no wait), the halt says
"Background jobs of this run are complete." A BackgroundLogs call reconciles
the job that it reads, so a job that the model already read gives no halt.
The wait stops at once on the turn abort (`ctx.abort`), SIGTERM, SIGINT or
SIGHUP (the signal listener has the fan-out tag). The max wait
`MINIMAL_AGENT_BG_HEADLESS_WAIT_MS` (default 20 min, max 24 min) is a total
for each turn, not for each stop: a job that never ends holds the turn for
about one max wait, also when the model starts more jobs. The total resets on
a new turn and on an allow with no running job. A worker also stops at its
budget deadline minus 60 s. At the deadline the hook halts with "continues to
run", and the next stops do not wait again. The hook `timeoutMs` (25 min) is
larger than the max wait. Set `MINIMAL_AGENT_BG_HEADLESS_WAIT=0` to disable
the wait. In a headless run, the BackgroundRun result says that the turn stays
open (the core gives `ctx.run` on the tool context).

## Persistence (durable, colocated, complete)

Everything lives under the session directory, so it travels with the transcript
and survives resume:

- `~/.minimal-agent/sessions/<sid>.bgjobs.jsonl`, the index (harness-owned), one
  JSON line per job.
- `~/.minimal-agent/sessions/<sid>.bgjobs/<jobId>.log`, the **full raw**
  combined stdout+stderr, verbatim bytes, ANSI preserved. Never truncated on
  disk. Model-facing reads are bounded and ANSI-stripped by default.
- `~/.minimal-agent/sessions/<sid>.bgjobs/<jobId>.status.json`, the runner's
  status sidecar, the reconcile source of truth.

The harness is the only writer of the index. Each runner is the only writer of
its own log and sidecar. No write races.

## Configuration

Optional. Read from `~/.minimal-agent/config.jsonc` under `plugins["ma-bg"]`. All
operator config. The model controls only what runs and an optional per-job
`timeout`.

```jsonc
{
  "plugins": {
    "ma-bg": {
      "enabled": true, // default true
      "defaults": {
        "timeout": "10m", // default per-job deadline
        "maxTimeout": "1d", // hard ceiling (a request over it is clamped)
        "allowInfinite": false // gate the "infinite" timeout escape hatch
      },
      "limits": {
        "maxConcurrent": 16, // running jobs at once
        "maxTotal": 128 // retained index records (oldest terminal evicted)
      },
      "log": {
        "maxModelBytes": 65536 // cap on a single model-facing read
      }
    }
  }
}
```

Set `MINIMAL_AGENT_DISABLE_BGJOBS=1` to turn the heartbeat reconcile off (jobs
still reconcile lazily when a tool is called).

## Tests

```
bun test          # unit + integration (no network)
bun run check     # typecheck + lint + format + biome + test
```

Unit tests inject fakes for every OS touch (no real process). The two
integration suites (`bin/runner.integration.test.ts`,
`handlers/handlers.integration.test.ts`, `handlers/heartbeat.integration.test.ts`)
run real, sub-second jobs through the real runner.

## Zero runtime dependencies

Like every plugin in this repo, this one ships no npm runtime dependencies. It
runs on Bun's standard library plus the TypeScript in this package.
