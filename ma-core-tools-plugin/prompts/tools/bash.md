Runs a bash command and returns its output.

Do not use Bash to search, read or count code. Use Grep for file contents and Glob for file names. Do not run `grep`, `rg`, `find`, `fd`, `ls`, `cat`, `head`, `tail` or `wc` in Bash. Use Bash for real shell work: builds, tests, git, package managers and file moves.

The output has a limit of ~64KB / 1000 lines, which keeps the start. A failed build puts its diagnostics at the end, so they get cut. Send only the tail (`... 2>&1 | tail -n 100`), or filter for them (`grep -nE 'error:|FAIL'`).

When the limit cuts the output, the harness adds a `[truncated: ...]` notice and saves the full text to a `<ma::agent::raw-output ... />` blob path. Read the tail of that blob for errors.

The user transcript keeps only ~10 lines of the body plus a `shown N/M L` summary. The tool_result you get back is not for visual content: ASCII art, banners, terminal previews, formatted tables or generated reports. Put it in your text reply instead, because the user reads the full reply.

The TUI preview can cut more than the API limit. The `<ma::agent::output-preview shown=N total=M>` annotation then carries a `path="..."` attribute when a blob exists. Read that path for the full output.

Do not use `sleep` or a polling loop to wait for a sub-agent, a job or a message. Your turn stays open while the command runs. A sleep delays the notice, because the harness sends it only between turns. End your turn to wait. Use a background tool when one is available. A sleep of a few seconds is correct only when the command needs it. Example: wait for a port.

The harness keeps the working directory between commands. It does not keep the shell state.
