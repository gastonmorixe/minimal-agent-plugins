Returns the active operating mode (for example, ASK) and its tool permission policy. Call this tool if you are not sure whether a mode is active. Example: after long thinking or many tool rounds. Use this tool to get a deterministic answer, not a guess from earlier reasoning.

The result is a JSON object: `{ id, label, since, permissions: { allow, deny } }`. `id: null` means that no mode is active and no tool restriction applies. `allow: ["*"]` means that every tool is permitted, except the tools in `deny`. If a tool is in `allow` and in `deny`, `deny` wins.

You do not need to call this tool regularly. Every tool_result that you receive ends with a `<ma::agent::mode-active id=... since=... />` stamp. The stamp has the same id as the result of this tool. Use this tool if no tool round occurred recently and you want to confirm the mode.
