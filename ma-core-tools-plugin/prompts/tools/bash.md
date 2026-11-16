Runs a bash command and returns its output.

Do not use Bash to search, read or count code. To search file contents, use Grep. To find or count files by name, use Glob. To read a file, use Read. Do not use these commands in Bash: `grep`, `rg`, `find`, `fd`, `ls`, `cat`, `head`, `tail` or `wc`. Use them only if no dedicated tool can do the task. Use Bash only for real shell work: builds, tests, git, package managers and file moves.

The output that you receive has a limit of ~64KB / 1000 lines, whichever comes first. The limit keeps the start of the output. A failed build or test run puts its diagnostics at the end of the output. Thus the limit removes the part that you need. For a long command, send only the tail to the output (`... 2>&1 | tail -n 100`). Or filter the output (`grep -nE 'error:|FAIL'`) so that the diagnostics stay in the output.

If the limit cuts the output, the harness adds a structured `[truncated: ...]` notice. The harness also saves the full output to a blob path in a `<ma::agent::raw-output ... />` tag. You can Read that path. To find errors, Read the tail of that blob.

The transcript of the user has a different limit. The transcript shows only the first ~10 lines of the output body. It shows the remaining lines as a summary: `shown N/M L`. Do not use Bash to show visual content to the user, because the user sees only a part of it. Examples of visual content: ASCII art, banners, ANSI TUI previews, formatted tables and generated reports. To show visual content, put it in your text reply. The user reads the full text reply.

The TUI preview can cut more lines than the API limit. If this occurs, the tool_result that you receive has a `<ma::agent::output-preview shown=N total=M>` annotation. The annotation shows you the difference on the next turn. If the harness saved a raw-output blob for that tool result, the annotation also has a `path="..."` attribute. This attribute points to the full output, so you can Read the full output directly.

Do not use `sleep` or a polling loop to wait for sub-agents, background jobs, messages or a specific time. While this command runs, your turn stays open. The harness sends completion notices only between turns. Thus, a sleep delays the notice that you wait for. To wait, end your turn. A completion notice starts a new turn automatically, also when you are idle.

If a tool for background commands or scheduled checks is available, use that tool. Do not use a long command or a sleep in Bash for this purpose. A sleep of a few seconds is correct when the command needs it. Example: wait for a port to open.

The harness keeps the working directory between commands. The harness does not keep the shell state.
