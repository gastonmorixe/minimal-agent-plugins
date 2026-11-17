Run a bash command and give its output.

Do not use Bash to find, read or count code: use `Grep`, `Glob` or `Read`. Use Bash for shell work, for example builds, tests, git, `bun install` and file moves.

The output has a limit of ~64KB / 1000 lines and keeps the start. Filter long output, or use `tail`. Put tables and reports in your text, not in output.

For long work, use `BackgroundRun`. To wait, end your turn: do not use `sleep`. Only a bare `cd <path>` stays. Each command has a new shell.
