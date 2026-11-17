Find text in files with a regex. The tool uses ripgrep and obeys .gitignore. Do not run `grep` or `rg` as a Bash command.

The output has a limit of ~64KB / 1000 lines. If many lines can agree, use `output_mode: "files_with_matches"` (only paths) or `"count"`. To make the output smaller, use `glob` or `path`.
