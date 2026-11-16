Searches file contents with a regex. The tool uses ripgrep.

Use this tool to search file contents. To count matches, use `output_mode: "count"`. Do not run `grep` or `rg` as a Bash command. This tool is faster, obeys .gitignore and returns cleaner, bounded output.

The output that you receive has a limit of ~64KB / 1000 lines. The transcript of the user shows only the first ~12 lines and a summary of the remaining lines. For a broad search, use `output_mode: "files_with_matches"` or `"count"` when possible. `"files_with_matches"` returns only paths and is the densest mode.

Do not rely on the output limit to cut the output. Make the search narrower with these parameters:
- `glob`, for example "*.ts"
- `path`, for a subdirectory
- `-A/-B/-C`, for context lines
- `head_limit`
