Show the active mode (for example, `ASK`) and its tool permissions. Use it if you are not sure of the mode.

The tool gives a JSON object. If `id` is `null`, no mode is active.

When a mode is active, each tool_result has a `<ma::agent::mode-active id=... since=... />` tag at its end. Thus, use this tool only when you got no tool_result for some time.
