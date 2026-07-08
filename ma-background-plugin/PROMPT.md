# Background jobs

You can run shell commands in the **background** and keep working while they run. Four tools: `BackgroundRun` (start), `BackgroundStatus` (glance), `BackgroundLogs` (read output), `BackgroundStop` (cancel).

## Default to the background

If a command takes more than a few seconds, run it in the background. Builds, test suites, installs, long `grep`/`find` over big trees, downloads, codegen, a dev server you will poll later: all of these belong in `BackgroundRun`. Fire it, keep working, and you get a one-line digest between turns when it finishes.

Use the foreground `Bash` tool only for quick commands (under ~5 seconds) whose output you need right now. Running three builds in parallel in the background and reading their logs when they are done beats running them one at a time and staring at each.

## How it works

- `BackgroundRun` returns immediately with a handle (`j1`, `j2`, ...) and a pid. The job runs concurrently. You are not blocked.
- When a job finishes you get a short digest injected between turns ("Background job j2 finished: succeeded (exit 0). Read it with BackgroundLogs j2."). You do not need to poll in a busy loop.
- `BackgroundStatus` is cheap. Call it for one job or all of them to see state, elapsed time, exit code, and a short tail. Poll it freely.
- `BackgroundLogs` is the full read. The on-disk log keeps every byte (ANSI and all). What comes back to you is bounded. Use `tail` for the last N lines, `grep` to filter, `offset`/`limit` for a range, and `since` (a byte cursor a prior call returned) to stream only new output. The full log is always there for a later read, even after a resume.
- `BackgroundStop` cancels a job (or all of them). Stop jobs you no longer need.

## Timeouts

- Every job has a deadline, 10 minutes by default. Set `timeout` to any duration when you need more or less: `"90s"`, `"30m"`, `"2h"`, `"1d"`. A job that hits its deadline is killed and reported as timed out, with whatever output it produced still readable. Pick a timeout that fits the work. 
- Do not set a huge one just in case.

## Things to know

- Jobs have **no stdin and no TTY**. They are non-interactive. A command that waits for input will hang until it times out. Do not background interactive REPLs or prompts.
- `cwd` is captured when the job starts and defaults to your current working directory. It does **not** follow the foreground `Bash` tool's sticky `cd`.
- Jobs are bound to this agent's lifetime. If the agent exits, every background job is torn down with it. They do not leak into the background of your machine.
- There is a limit on how many jobs run at once. If you hit it, stop one you no longer need or wait for one to finish.
