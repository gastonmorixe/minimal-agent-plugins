# Bidi MCP tools — postmortem (2026-07-29)

How MA's Cursor provider gained bidirectional tool execution on a single HTTP/2
stream, and the chain of bugs that had to be fixed to make it work.

## Context

minimal-agent's Cursor plugin (`ma-llm-cursor-plugin`) speaks Cursor's
`AgentService/Run` API — a Connect RPC service over HTTP/2 with protobuf
payloads. The original implementation was unary: one POST per agent loop step,
tool results folded back into conversation history on the next request.

Cursor's IDE uses a **bidi** (bidirectional) pattern instead: a single HTTP/2
stream stays open for the entire user turn. When the model calls a tool, the
server sends `exec_server_message` and blocks; the client writes
`exec_client_message` (with the tool result) on the same stream; the server
continues.

This postmortem covers the work to implement that bidi pattern in MA and the
bugs encountered along the way.

## Timeline

### Phase 1: Bidi wire plumbing

**Problem:** The unary path called `stream.end()` after writing the request body.
The server waited for a tool result on the same stream that was already closed.
Result: TUI hung on "Receiving stream ⋯ stalled".

**Fix:** Used `NetworkClient` with `keepRequestOpen` to hold the HTTP/2 stream
open. Added `writeRequestBody` / `endRequestBody` to the `NetworkResponse`
interface so tool results can be written after the initial request.

**Secondary bug:** `tapResponse()` in `minimal-agent-core/src/network/client.ts`
stripped `writeRequestBody` from the response object (it only forwarded known
properties). Fixed to forward write/end methods.

### Phase 2: Envelope generator lifecycle

**Problem:** `readBidiUntilPauseOrEnd()` consumed frames via `for-await-of` on
the envelope async generator. When it returned (to pause for tool execution),
`for-await-of` closed the generator. The next call to `readBidiUntilPauseOrEnd`
got `{ done: true }` immediately — no more frames, even though the HTTP/2 stream
was still receiving data.

**Fix:** Refactored the translator into `CursorBidiEnvelopeTranslator` — a
stateful class that holds the generator and manually calls `envelopeGen.next()`
instead of using `for-await-of`. The generator stays alive across pause/resume
cycles within the same turn.

### Phase 3: Session cleared too early

**Problem:** The bidi session was cleared on every `message_stop` event. But
during a tool-use pause, the server sends `message_delta(stopReason: tool_use)`
followed by `message_stop` — this is the normal end-of-turn signal that means
"I'm done talking, waiting for tool result". Clearing the session here destroyed
the write handle needed to send the tool result.

**Fix:** In `readBidiUntilPauseOrEnd`, check if `message_stop` follows a
`message_delta(stopReason: tool_use)` AND a `pendingExec` exists. If so, keep
the session alive. Only clear on message_stop when there's no pending tool.

### Phase 4: Native exec handling

**Problem:** Despite sending `x-cursor-agent-exclude-tools` headers to suppress
native built-in tools, the server sometimes still dispatched native execs
(`shell_args`, `read_args`, `grep_args`, `ls_args`) instead of or alongside MCP
execs.

Two sub-problems:

1. The decoder only handled `mcp_args` (field 11) and ignored native exec oneofs.
   Native tool requests were silently dropped, causing the server to wait
   indefinitely → stream truncation.

2. Tool results for native execs must be encoded as the matching native result
   type (`shell_result`, `grep_result`, etc.), not `mcp_result`. Sending the
   wrong result type caused the server to close the stream.

**Fix:**

- `decodeExecServerMessageBody()` now handles all native exec fields (2, 3, 5,
  7, 8, 14, 20) and maps each to the closest MA tool (Bash, Grep, Read, Glob,
  Write, Fetch). MCP (field 11) takes priority.

- `encNativeResult()` / `encNativeError()` in `client-message.ts` encode
  results with the correct native result oneof and field layout. The
  `nativeExecFieldNo` from the decode stage is threaded through to the encode.

### Phase 5: Protobuf map decode

**Problem:** `McpArgs.args` is `map<string, google.protobuf.Value>`. In protobuf
wire format, map fields are encoded as repeated messages — one field-2 message
per key-value pair. The decoder was treating each field-2 occurrence as the
entire map (calling `decodeStringValueMap()` on it) and overwriting the result.
With a single-key map like `{command: "wc -w README.md"}`, this happened to
produce a garbled result; with multi-key maps, only the last entry survived.

**Fix:** Introduced `decodeMapEntry()` to decode a single map entry (key=field 1,
value=field 2). All decode sites now iterate field-2 entries and accumulate
key-value pairs into one object. Applied to three files:
- `proto/exec-server-decode.ts` (decodeMcpArgsBody)
- `proto/exec-mcp.ts` (decodeExecServerMcpRequest)
- `proto/tool-call-decode.ts` (decodeMcpArgs for tool_call_started)

### Phase 6: google.protobuf.Value field mapping

**Problem:** `decodeProtobufValue()` had the wrong field-to-type mapping.
`google.protobuf.Value` is a oneof where:

```
field 1 = null_value   (NullValue enum, wire 0)
field 2 = number_value (double, wire 1 — 8 bytes fixed)
field 3 = string_value (string, wire 2)
field 4 = bool_value   (bool, wire 0)
field 5 = struct_value (Struct, wire 2)
field 6 = list_value   (ListValue, wire 2)
```

The implementation had these shifted: field 2 decoded as string, field 3 as
boolean, field 4 as struct, field 5 as list. So a string tool argument like
`command: "wc -w README.md"` (sent as `string_value` at field 3) was decoded
as `false` (`f.value === 1` returned false).

**Fix:** Corrected the switch cases in `decodeProtobufValue()` to match the
official proto3 layout. Added proper wire-type-1 handling for `number_value`
(8-byte little-endian double via `DataView.getFloat64`).

### Phase 7: Missing tool_use_input_delta

**Problem:** Even with correct protobuf decoding, tools still received `{}` as
input. The bidi translator emitted `tool_use_start → tool_use_stop` with input
on the stop event, but the host adapter (`adapter-legacy.ts` in core) never
reads `tool_use_stop.input`. Instead, it accumulates JSON text from
`tool_use_input_delta` events and parses it at stop time via
`safeParseToolInput(accumulated)`. With no input_delta events, the accumulated
string was `""`, parsed as `{}`.

**Fix:** Both `response-stream-bidi.ts` (bidi) and `response-stream.ts` (unary)
now emit a `tool_use_input_delta` event with `partialJson: JSON.stringify(input)`
between `tool_use_start` and `tool_use_stop`.

## Lessons

1. **Read the host adapter, not just the event types.** The canonical event
   interface had an `input` field on `tool_use_stop`, but the host never read
   it. The actual contract was `tool_use_input_delta` → `safeParseToolInput`.

2. **Protobuf map fields are repeated messages.** Each `map<K,V>` entry is a
   separate field occurrence, not a single nested message containing all entries.

3. **google.protobuf.Value has a non-obvious wire layout.** `number_value` is
   field 2 with wire type 1 (fixed 64-bit double), not wire type 0 (varint).
   Getting the field-to-type mapping wrong produces silent data corruption (a
   string becomes a boolean, a number becomes garbage).

4. **`for-await-of` closes the generator on break/return.** If you need to
   pause iteration and resume later on the same stream, use manual `.next()`
   calls on the generator instead.

5. **Servers may send native execs despite exclude headers.** Defensive
   decoding of all exec oneofs is necessary even when you've told the server
   to only use MCP.

## Files changed

| File | Change |
|------|--------|
| `proto/value-decode.ts` | `decodeMapEntry()`, fixed `decodeProtobufValue()` field mapping |
| `proto/exec-server-decode.ts` | Per-entry map decode, native exec handling, `nativeExecFieldNo` |
| `proto/exec-mcp.ts` | Per-entry map decode |
| `proto/tool-call-decode.ts` | Per-entry map decode |
| `proto/client-message.ts` | `encNativeResult()` / `encNativeError()` for typed native results |
| `response-stream-bidi.ts` | `tool_use_input_delta` emission, stateful translator, session lifecycle |
| `response-stream.ts` | `tool_use_input_delta` emission (unary path) |
| `bidi-run.ts` | Session continuation logic, `nativeExecFieldNo` pass-through |
| `cursor-bidi-session.ts` | Session state management |
| `connect/bidi-stream.ts` | Duplex h2 wire |
| `minimal-agent-core/.../client.ts` | Forward `writeRequestBody` through `tapResponse()` |
