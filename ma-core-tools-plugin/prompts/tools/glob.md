Find files with a pattern for file names and paths.

Use this tool to find files by name or path. Do not use `find`, `fd` or `ls` in Bash for this task. The tool can use glob patterns, for example `**/*.ts` or `src/**/*.{js,ts}`.

The tool gives the paths of the files that agree with the pattern. The tool stops after 100 paths and does not give the total. Thus, do not use it to count more than 100 files. The tool sorts the paths by name, not by the time of the last change.

Put the glob string in `pattern`. You can also use the alias `glob_pattern`. Put the directory to examine in `path`. The default is cwd. You can also use the alias `target_directory` for `path`. If you set a name and its alias, the tool uses the value of the name.
