Show the active mode (for example, `ASK`) and the tool permissions of that mode. Use this tool if you are not sure that a mode is active. For example, use it after much thought or after many tool results. The tool gives the data from the harness. Thus you do not have to find the mode from your previous text.

The tool gives a JSON object: `{ id, label, since, permissions: { tools, source } }`. Each item in `tools` has the shape `{ tool, allow, refusalHint? }`. The value of `allow` is `true`, `false` or `"match"`. The value of `source` is `manifest`, `user-config` or `default`. If `id` is `null`, no mode is active. Then `tools` is `[{ tool: "*", allow: true }]`, and the mode does not stop a tool.

To find the permission of a tool, the harness first examines the items that have the name of that tool. The first of these items gives the permission. If no item has that name, the harness uses the first item with `tool: "*"`. With `"match"`, a check of the tool input gives the permission.

You do not have to use this tool frequently. When a mode is active, each tool_result ends with a `<ma::agent::mode-active id=... since=... />` tag. The tag has the same id as the result of this tool. If you did not get a tool_result for some time, use this tool to make sure of the mode.
