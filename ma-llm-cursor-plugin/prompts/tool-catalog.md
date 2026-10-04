Available tools with their complete descriptions and input schemas follow.

Cursor also exposes a server-side MCP bridge: GetDynamicTools (list/filter)
and CallDynamicTool (invoke a tool in a namespace with arguments). Prefer
calling each minimal-agent tool directly by its exact name below. Use the
parameter names, required fields, enum values and nested structures in its
input_schema when constructing arguments. These schemas describe the tools
available in this session.
