Runs a bash command and returns its output.

Do not use Bash to search, read or count code. To search file contents, use Grep. To find or count files by name, use Glob. To read a file, use Read. Do not run `grep`, `rg`, `find`, `fd`, `ls`, `cat`, `head`, `tail` or `wc` in Bash. Use them only when no dedicated tool can do the task. Use Bash only for real shell work: builds, tests, git, package managers and file moves.

The output has a limit of ~64KB / 1000 lines, which keeps the start. A failed build puts its diagnostics at the end, so they get cut. Send only the tail (`... 2>&1 | tail -n 100`), or filter for them (`grep -nE 'error:|FAIL'`).

When the limit cuts the output, the harness adds a `[truncated: ...]` notice and saves the full text to a `<ma::agent::raw-output ... />` blob path. Read the tail of that blob for errors.

The user transcript keeps only ~10 lines of the body plus a `shown N/M L` summary. Do not use Bash to show visual content to the user through a tool_result. That covers ASCII art, banners, terminal previews, formatted tables and generated reports. Put it in your text reply instead, because the user reads the full reply.

The TUI preview can cut more than the API limit. The `<ma::agent::output-preview shown=N total=M>` annotation then carries a `path="..."` attribute when a blob exists. Read that path for the full output.

Do not use `sleep` or a polling loop to wait. That covers a sub-agent, a background job, a message and a scheduled time. Your turn stays open while the command runs. A sleep delays the notice, because the harness sends it only between turns. End your turn to wait. A completion notice starts a new turn, also when you are idle. If a tool for background commands or scheduled checks is available, use that tool. Do not use a long command or a sleep in Bash for this purpose. A sleep of a few seconds is correct only when the command needs it. Example: wait for a port.

The harness keeps the working directory between commands. It does not keep the shell state.
