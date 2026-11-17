Run a bash command and give its output.

Do not use Bash to find, read or count code. To find text in files, use `Grep`. To find or count files by name, use `Glob`. To read a file, use `Read`. Do not run `grep`, `rg`, `find`, `fd`, `ls`, `cat`, `head`, `tail` or `wc` in Bash. Use these commands only when no dedicated tool can do the task.

Use Bash only for shell work. For example: run a build, run tests, use git, install packages and move files.

The output has a limit of ~64KB / 1000 lines. The limit keeps the start of the output. A build with errors puts its diagnostics at the end, thus the limit cuts them. Send only the last lines to the output (`... 2>&1 | tail -n 100`). As an alternative, filter the output (`grep -nE 'error:|FAIL'`).

When the limit cuts the output, the harness adds a message that starts with `[truncated:`. The harness can also save up to the first 256000 bytes of the output in a blob. The `<ma::agent::raw-output ... />` tag gives the path of the blob. To find errors, Read the end of that blob.

The transcript of the user keeps only ~10 lines of the body and a `shown N/M L` summary. Do not use Bash to show visual content to the user through a tool_result. Visual content includes ASCII diagrams, large text titles, terminal previews, formatted tables and reports. Put that content in your text response. The user reads all of your response.

The TUI preview can cut more than the API limit. Then the `<ma::agent::output-preview shown=N total=M>` tag has a `path="..."` attribute if a blob is available. To get more of the output, Read that path. The blob holds only up to the first 256000 bytes of the output.

Do not use `sleep` or a loop of checks to wait. This rule applies to a sub-agent, a background job, a message and a scheduled time. Your turn stays open while the command runs. The harness sends a message only between turns. Thus, during a `sleep`, the message cannot come to you. To wait, end your turn.

When a job or a task is complete, its message starts a new turn, also when you are not in a turn. If a tool for background commands or scheduled checks is available, use that tool. Do not use a long command or a `sleep` in Bash to wait. A `sleep` of some seconds is correct only when the command must wait. For example, wait for a port.

The harness keeps the cwd between commands only after a command that is only `cd <path>`. A `cd` in a longer command, for example `cd x && make`, does not change the kept cwd. Each command runs in a new shell. Thus other changes to the shell do not stay for the next command.
