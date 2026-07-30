# Cursor Bidi Tool Retry Bug Analysis

## Correction (2026-07-29): ShellStreamArgs args shape

**Earlier draft of this note was wrong about the args message type.**

In Cursor’s `agent.v1.ExecServerMessage` (rev-eng / agent-cli):

- Field **2** `shell_args` → type `agent.v1.ShellArgs` (`T: i.a`)
- Field **14** `shell_stream_args` → **same** type `agent.v1.ShellArgs` (`T: i.a`)

`ShellArgs` fields include:

| No | Name |
|----|------|
| 1 | `command` |
| 2 | `working_directory` |
| 4 | `tool_call_id` |
| … | timeout, sandbox, etc. |

So `decodeNativeExecInput` fallthrough `case 2` / `case 14` reading field 1 as
`command` is **correct**. The decode crash with `command.match` on `undefined`
was from other failure modes (bad bytes / skipped MCP path / empty command),
not from a mythical “repeated ShellStreamInput args” shape.

## What *is* different: the result oneof

| Server args | Client result |
|-------------|---------------|
| `shell_args` (2) | unary `shell_result` (2) = `ShellResult` |
| `shell_stream_args` (14) | streamed `shell_stream` (14) = `ShellStream` events |

`ShellStream` is a oneof of **events**: `stdout` / `stderr` / `exit` / `start` /
`rejected` / … — **not** `ShellResult { success: ShellSuccess }`.

Cursor’s client yields:

1. `ShellStream { start }`
2. zero or more `stdout` / `stderr`
3. `ShellStream { exit }`
4. then `stream_close`

Encoding a ShellSuccess blob into field 14 is a protocol error. Fix:
`encodeShellStreamExecFrames()` in `client-message.ts`, used from `bidi-run.ts`
when `nativeExecFieldNo === 14`.

## Why Cursor switches MCP → native shell_stream

When the MCP result path fails (wrong continue / polluted result / missing
`mcp_result`), the server may retry with `shell_stream_args`. That is Cursor’s
fallback, not something MA chooses. MA must:

1. Keep a **stable** bidi session key and write `mcp_result` on the open stream
   (primary path — see core `canonical-send` sessionId fix).
2. If field 14 still arrives, decode `ShellArgs` and reply with proper
   `ShellStream` frames.

## TOOL_CALL_ID_FIELD for field 14

`ShellArgs.tool_call_id` is field 4 for both shell and shell_stream args.
`TOOL_CALL_ID_FIELD` includes `[14, 4]`.
