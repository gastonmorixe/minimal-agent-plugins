# Cursor Bidi Duplicate Tool Use Bug — Investigation Findings

## Summary

The `CursorBidiEnvelopeTranslator.push()` method emits **duplicate `tool_use_start`/`tool_use_stop` events** when Cursor sends a tool call through two separate frames: first via an `interaction_update` (field 1), then via an `exec_server_message` (field 2). Both are yield to MA's event processor, which creates **two tool_use blocks** in the response — the first with potentially incomplete input from the interaction_update, the second with the authoritative input from the exec_server_message.

## The Two Representation Problem

Cursor's bidi protocol represents the same MCP tool call in TWO places on the wire:

1. **InteractionUpdate** (AgentServerMessage field 1): Contains `ToolCallStartedUpdate` (field 2) and `ToolCallCompletedUpdate` (field 3) with the MCP tool call args decoded from the `mcp_tool_call` oneof (field 15).

2. **ExecServerMessage** (AgentServerMessage field 2): Contains `mcp_args` (field 11) with the FULL MCP tool call args as protobuf map entries.

## Code Path Trace

### File: `response-stream-bidi.ts`

**`push()` method (line 93)** checks the two fields in ORDER:

```typescript
// Line 122-128: FIRST, check if field 2 (exec_server_message) is present
const execFromField2 = decodeAgentServerExec(frame.payload);
if (execFromField2) {
    const events = this.emitExecMcpToolUse(execFromField2);
    this.pendingExec = execFromField2;
    return { events, streamEnded: false, pauseForToolUse: true };
}

// Line 130: SECOND, fall through to handle interaction_update (field 1)
const { events, turnEnded, pauseForToolUse } = this.handleServerPayload(frame.payload);
```

For a frame with ONLY field 1 (interaction_update), `decodeAgentServerExec()` returns `undefined`, so it falls through to `handleServerPayload()`.

For a frame with field 2, `decodeAgentServerExec()` returns the exec args, and the method returns early — field 1 (if also present) is NEVER processed for that frame.

### Frame 1: Interaction_update (field 1 only)

`handleServerPayload()` (line 287) calls `extractServerTextEvents()` which extracts:

- `tool_call_started` → `handleMcpToolCall(call, "started")` (line 297):
  - Emits `message_start`, `tool_use_start` (index 0), `tool_use_input_delta`, `tool_use_stop` (index 0).
  - Sets `pendingToolIndex`, `pendingToolId`, `pendingToolName`, `pendingToolInput = call.input`.
  - If `call.input` is non-empty, calls `emitToolUseStop()` (line 260) which emits `tool_use_input_delta` + `tool_use_stop` using `call.input`, then clears `pendingToolIndex`.
  - Returns `pause: false` (line 262).

- `tool_call_completed` → `handleMcpToolCall(call, "completed")` (line 303):
  - If `pendingToolIndex` is undefined (cleared above), creates NEW `tool_use_start` (index 1).
  - Calls `emitToolUseStop()` → emits `tool_use_input_delta` + `tool_use_stop` (index 1).
  - Calls `finish("tool_use")` → emits `message_delta(tool_use)` + `message_stop`.
  - Returns `pause: true`.

### Frame 2: Exec_server_message (field 2)

`push()` enters the `if (execFromField2)` block (line 123):

`emitExecMcpToolUse()` (line 203):
- Emits `tool_use_start` (index = `this.blockIndex++`, say 2).
- Emits `tool_use_input_delta` + `tool_use_stop` with `exec.input`.
- Calls `finish("tool_use")` → emits `message_delta(tool_use)` + `message_stop`.

`this.pendingExec` is set to `execFromField2` (line 125) — the AUTHORITATIVE exec args.

### How `readBidiUntilPauseOrEnd()` (bidi-run.ts, line 168) handles pausing

```typescript
// Line 191: translate the frame
const { events, streamEnded, pauseForToolUse } = session.translator.push(next.value);

// Line 200-229: yield ALL events to MA
for (const event of events) {
    yield event;  // <-- Every event flows to MA's tool executor

    // Line 208: detect tool_use stop reason
    if (event.type === "message_delta" && event.stopReason === "tool_use") {
        sawToolUseDelta = true;
        session.pendingExec = session.translator.getPendingExec() ?? null;
        // For frame 1: getPendingExec() returns undefined! pause is skipped.
    }
    // Line 217: message_stop
    if (event.type === "message_stop") {
        if (sawToolUseDelta && session.pendingExec) {
            return; // Pause for tool execution (frame 2 only)
        }
        return; // End (frame 1 falls here — no pendingExec)
    }
}

// Line 235: backup pause mechanism
if (pauseForToolUse) {
    session.pendingExec = session.translator.getPendingExec() ?? null;
    // For frame 1 with tool_call_completed: pendingExec is null → continues
    // For frame 2: pendingExec is set → pauses
}
```

**Critical observation:** `session.pendingExec` is never set for frame 1 (interaction_update only sets `this.pendingExec` when it encounters `exec_server_message` events, which it doesn't in frame 1). The tool execution pause only triggers when both `sawToolUseDelta` AND `session.pendingExec` are truthy, which only happens after frame 2.

### MA's Event Processor: `adapter-legacy.ts` (line 897-914)

```typescript
case "tool_use_start":
    flushCur();  // flushes prior cur (if any) as a completed block
    cur = { kind: "tool_use", id: ev.id, name: ev.name, json: "" };
    break;

case "tool_use_input_delta":
    if (cur?.kind === "tool_use") {
        cur.json += ev.partialJson;
    }
    break;

case "tool_use_stop":
    if (cur?.kind === "tool_use") flushCur({ countCompletedTool: true });
    break;
```

`flushCur()` (line 793):
```typescript
} else if (cur.kind === "tool_use") {
    blocks.push({
        type: "tool_use",
        id: cur.id,
        name: cur.name,
        input: safeParseToolInput(cur.json),
    });
    if (opts?.countCompletedTool) {
        progress = { ...progress, completedToolCalls: progress.completedToolCalls + 1 };
    }
}
```

**No deduplication.** Each `tool_use_start`/`tool_use_stop` pair unconditionally creates a new block in `blocks[]`.

## The Actual Scenario (from debug transcript)

The debug transcript shows:
- **Frame 1**: interaction_update → 3 events: `message_start`, `tool_use_start`, `tool_use_stop`
  - No `tool_call_completed` in this frame, so no `message_delta`/`message_stop`.
  - `pendingToolIndex` was set then cleared by `emitToolUseStop()`.
  - No pause — the loop continues to read Frame 2.
- **Frame 2**: exec_server_mcp → 4 events: `tool_use_start`, `tool_use_stop`, `message_delta`, `message_stop`
  - The authoritative exec args are here.
  - This IS the frame that triggers the pause.

## What MA Actually Executes

MA's event processor (`adapter-legacy.ts`) processes events linearly:

1. From Frame 1: `tool_use_start` → sets `cur`. `tool_use_stop` → pushes **Block 0** to `blocks[]` with input from `call.input` (interaction_update's MCP args).
2. From Frame 2: `tool_use_start` (line 898 call to `flushCur()` — `cur` is null, no-op). Sets `cur` to new tool_use. `tool_use_stop` → pushes **Block 1** to `blocks[]` with input from `exec.input` (exec_server_message's MCP args).
3. `message_delta`/`message_stop` → stream ends with `stopReason: "tool_use"`.

**Result:** `blocks[]` contains TWO tool_use blocks for the same MCP tool call. The agent loop iterates all blocks and executes each tool_use it finds. **The tool gets executed TWICE** — once with the interaction_update's input, once with the exec_server_message's input.

## Input Completeness

The interaction_update's input (`call.input` from `DecodedCursorMcpToolCall`) comes from `decodeMcpArgs()` in `tool-call-decode.ts` (line 35), which decodes field 2 (map entries) from the `mcp_tool_call` oneof inside the `ToolCallStartedUpdate/ToolCallCompletedUpdate`.

The exec_server_message's input (`exec.input` from `DecodedExecMcpArgs`) comes from `decodeMcpArgsBody()` in `exec-server-decode.ts` (line 26), which decodes field 2 (map entries) from `mcp_args` (field 11) in the `ExecServerMessage`.

Both decode the same protobuf structure (map entries in field 2). However, Cursor may populate the `ToolCallStartedUpdate` with a **partial or empty** arg set (just enough for UI rendering) while the `ExecServerMessage` carries the **full** arg set (authoritative for execution). If the interaction_update's args are empty/partial, then Block 0 would have a tool_use with `{}` or partial args, causing the tool execution to fail or run with default parameters.

## Root Cause

The translator does not deduplicate tool_use events across the interaction_update and exec_server_message representations of the same tool call. It emits canonical events from BOTH sources, and the core event processor treats each `tool_use_stop` as a new completed tool call.

There is no "skip this if we already emitted it from the other path" logic anywhere in `push()`, `emitExecMcpToolUse()`, or `handleMcpToolCall()`.

## Key Line Numbers

| File | Line(s) | Description |
|------|---------|-------------|
| `response-stream-bidi.ts` | 122-128 | Exec check runs FIRST; returns early on exec_server_message |
| `response-stream-bidi.ts` | 130 | Falls through to interaction_update only when no exec |
| `response-stream-bidi.ts` | 203-227 | `emitExecMcpToolUse()` — emits duplicate tool_use events from exec |
| `response-stream-bidi.ts` | 229-285 | `handleMcpToolCall()` — emits tool_use events from interaction_update |
| `response-stream-bidi.ts` | 244-262 | `started` phase: sets pendingToolInput, emits tool_use_start/stop |
| `response-stream-bidi.ts` | 265-284 | `completed` phase: merges input, emits tool_use_start/stop + finish |
| `response-stream-bidi.ts` | 168-190 | `emitToolUseStop()` — flushes pending tool state |
| `response-stream-bidi.ts` | 192-201 | `finish()` — emits message_delta/message_stop |
| `bidi-run.ts` | 191-249 | `readBidiUntilPauseOrEnd` — yields all events, pause logic |
| `bidi-run.ts` | 208-216 | `session.pendingExec` only set when message_delta + tool_use |
| `bidi-run.ts` | 235-243 | Backup pause: `pendingExec` may be null for interaction_update only |
| `adapter-legacy.ts` | 897-914 | `tool_use_start`/`tool_use_stop` handlers — no deduplication |
| `adapter-legacy.ts` | 809-822 | `flushCur` for tool_use — unconditionally pushes block |
| `proto/exec-server-decode.ts` | 217-236 | `decodeAgentServerMessage` — detects kind |
| `proto/exec-server-decode.ts` | 239-247 | `decodeAgentServerExec` — extracts field 2 exec |
| `proto/exec-server-decode.ts` | 154-188 | `decodeExecServerMessageBody` — full args decode |
| `proto/tool-call-decode.ts` | 35-59 | `decodeMcpArgs` — interaction_update args decode |
| `proto/tool-call-decode.ts` | 115-127 | `decodeToolCallUpdate` — interaction_update tool call decode |
| `proto/agent-run.ts` | 183-237 | `extractServerTextEvents` — extracts tool_call_started/completed |
