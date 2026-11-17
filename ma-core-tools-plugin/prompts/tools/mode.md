Show the active mode (for example, `ASK`) and its tool permissions. Use it if you are not sure of the mode.

The tool gives a JSON object. If `id` is `null`, no mode is active.

When a mode is active, each tool_result ends with a `<ma::agent::mode-active id=... since=... />` tag. Thus use this tool only if you did not get a tool_result for some time.
