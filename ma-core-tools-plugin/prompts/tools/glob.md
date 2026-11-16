Finds files that match a pattern for file names and paths. The tool is fast for a codebase of any size.

Use this tool to find or count files by name or path. Do not use `find`, `fd` or `ls` in Bash for this task. The tool supports glob patterns, for example `**/*.ts` or `src/**/*.{js,ts}`. The tool returns the paths of the matching files, sorted by modification time.

Put the glob string in `pattern`. You can also use the alias `glob_pattern`. Put the search directory in `path`. The default is cwd. You can also use the alias `target_directory` for `path`. If you set a canonical name and its alias, the canonical name wins.
