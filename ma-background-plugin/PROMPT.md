Default to the background. If a command takes more than a few seconds, use `BackgroundRun`. Use the foreground `Bash` tool only for a quick command whose output you need now.
A job dies when this agent exits, and it does not follow the sticky `cd` of the foreground `Bash` tool.
There is a limit on how many jobs run at once. If you hit it, stop a job you no longer need.
