Run a bash command and give its output.

Do not use Bash to find, read or count code: use `Grep`, `Glob` or `Read`. Use Bash only for shell work: builds, tests and git.

The output has a limit of ~64KB / 1000 lines and keeps the start. Filter long output, or send only the end (`... 2>&1 | tail -n 100`).

To wait for a job, end your turn. Do not use `sleep` or a loop of checks. When the job is complete, its message starts a new turn.

Only a command that is only `cd <path>` keeps the cwd.
