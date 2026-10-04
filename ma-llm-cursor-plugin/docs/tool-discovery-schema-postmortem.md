# Tool discovery omitted the schemas (2026-10-03)

Cursor sessions still produced invalid tool arguments after the allowlist and
conversation-state fixes. Read used `path`, Task used `task_id` or object-valued
children, and SubAgentsSpawnAgent used `prompt`. Asking for the tool schemas
did not reliably resolve the problem.

## Evidence and history

- `eb1c76f` switched to an MCP allowlist. Cursor requires
  `get_mcp_tools_tool_call`, so the model still sees its discovery bridge.
- `95db02f` retained server conversation state across fresh Runs. This addressed
  fake tool calls emitted as text, a separate failure.
- `f7834df` intercepted unregistered MCP execs. `GetDynamicTools` returned a
  successful catalog, while other unknown names returned an error with the same
  catalog. That fixed the earlier `Unknown tool` response.
- That catalog contained only names and the first 160 characters of each
  description's first line. It contained **no input schemas**. Its unit test
  explicitly expected later description lines to be absent.
- Saved sessions `f20667ed` and `43ec2d53` contain the reported Read argument
  mismatch. The latter also contains Task `task_id`, object-valued children,
  and SubAgentsSpawnAgent `prompt`, followed by corrected calls.
- In the official CLI bundle `2026.09.28-64d2043`, the MCP mapper `Lm` encodes
  schemas using `inputSchemaJson: JSON.stringify(e.inputSchema)` when that
  option is enabled. The `McpToolDefinition` descriptor places
  `input_schema_json` at field 6. MA uses the same field and preserves the
  canonical schema in both the Run request and MCP-state response.

The missing discovery schema is observed directly. It explains why querying
the intercepted bridge could not teach the model the correct arguments. It
does not establish that every invalid initial tool call was caused by that
bridge; model familiarity with other tools' conventions can also contribute.

Two other transcript observations match the current host contract: Grep
defaults to `files_with_matches`, so getting content requires
`output_mode: "content"`; finishing the last open Task child automatically
finishes its parent, so completing that parent again correctly returns
`already done`. Task's full description documents the latter behavior.

## Reproduction

From the plugins repository:

```sh
bun test ma-llm-cursor-plugin/bidi-unregistered-mcp.test.ts -t 'exact input schema'
```

Before the fix, the expected Read schema required `file_path`, but the actual
reply was just a catalog heading and `- Read: Read a file.` The test failed
in milliseconds without credentials or a network connection.

## Fix and coverage

The bridge now returns every registered tool's full description and exact
`inputSchemaJson`, without taking the first line or truncating it. The catalog
preamble lives in `prompts/tool-catalog.md`. Unknown-tool errors use the same
complete catalog. Registered calls still pass through to the host.

Coverage verifies both the small reproduction and the actual bidi response.
The latter decodes the MCP result's protobuf text content and checks Read's
required `file_path`, Task's action enum and nested string children, and
SubAgentsSpawnAgent's required `task`. The discovery call is answered on the
wire, never emitted as a host tool invocation, and the stream continues.

The full plugins gate passed with 4,299 tests, 19 skips and no failures. A live
`cursor-auto` probe with simulated executors produced these arguments in order:

```json
{"file_path":"fixture.txt"}
{"action":"add_many","tasks":[{"title":"Check","children":["Inspect"]}]}
{"action":"update","id":"1a","status":"done"}
{"name":"inspector","task":"Inspect fixture.txt and report its contents."}
```

The live probe did not invoke the intercepted discovery bridge. It verifies
ordinary tool calling with these schemas; the deterministic bidi test verifies
the changed bridge response. No subagent was actually spawned by the probe.

No aliases or argument rewriting were added. The catalog supplies the current
schemas so the model can construct the host's actual arguments. Existing
long-running sessions may retain previous bad examples in their conversation;
restarting the process loads the updated plugin, and requesting discovery
returns the complete current definitions.
