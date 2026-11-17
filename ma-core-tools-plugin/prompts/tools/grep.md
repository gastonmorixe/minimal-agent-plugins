Find text in files with a regex. The tool uses ripgrep.

Use this tool to find text in files. To count the lines that agree with the regex, use `output_mode: "count"`. Do not run `grep` or `rg` as a Bash command. The tool obeys .gitignore and gives output with a limit.

The output that you receive has a limit of ~64KB / 1000 lines. The transcript of the user shows only the first ~12 lines and a summary of the remaining lines. If many lines can agree with the regex, use `output_mode: "files_with_matches"` or `"count"` when possible. `"files_with_matches"` gives only paths, and it gives the shortest output.

Do not let the output limit cut the output. To make the output smaller, use these parameters:
- `glob`, for example `"*.ts"`
- `path`, for a directory in the project
- `-A/-B/-C`, for context lines
- `head_limit`
