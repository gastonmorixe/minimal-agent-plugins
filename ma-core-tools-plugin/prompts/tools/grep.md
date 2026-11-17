Find text in files with a regex. The tool uses ripgrep and obeys .gitignore. Do not run `grep` or `rg` as a Bash command.

The output has a limit of ~64KB / 1000 lines. The default `output_mode` (`files_with_matches`) gives only the paths. For the lines, use `"content"`. To make the output smaller, use `glob` or `path`.
