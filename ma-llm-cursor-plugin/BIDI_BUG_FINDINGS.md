# Cursor Bidi Tool Execution Bug — Investigation Findings

## Summary

Two bugs collude to produce the observed behavior. First, `<ma::agent::mode-active>` annotations from MA's core leak into tool results sent to Cursor. Second, native exec results for `shell_stream_args` (field 14) and other native exec types lack proper ShellResult encoding, so Cursor receives malformed protobuf that it can't parse. The combined effect: Cursor gets a polluted, wrongly-shaped response and retries with a different exec strategy.

---

## Finding 1: Mode-active annotations are NOT stripped from tool-result wire text

### The injection site (core)

`minimal-agent-core/src/agent/tool-round.ts`, lines **874–877**:

```typescript
const modeStamp = ctx.modeManager?.buildActiveModeStamp() ?? null;
if (modeStamp) {
  content = content.length > 0 ? `${content}\n\n${modeStamp}` : modeStamp;
}
```

Every tool result (including errors) gets the `<ma::agent::mode-active id="..." since="..." />` stamp appended to its `content` string. This stamp becomes part of the `ToolResultBlock.content` at lines 894–898.

### The extraction path (no stripping)

`bidi-tool-results.ts`, lines **37–43**:

```typescript
export function toolResultToWireText(block: ToolResultBlock): string {
  const parts: string[] = [];
  for (const c of block.content) {
    if (c.type === "text" && c.text) parts.push(c.text);
  }
  return parts.join("\n") || "(empty tool result)";
}
```

This function joins **all** text blocks verbatim. It does not filter or strip `<ma::agent:...>` XML annotations. No sanitization happens at any later point either — `encodeAgentClientMessageExecResult` in `proto/client-message.ts` lines 140–142 passes `resultText` straight through to the protobuf encoder.

### The wire path

`bidi-run.ts`, lines **145–160**:

```typescript
const resultText = toolResultToWireText(match);          // line 145 — gets polluted text
const payload = encodeAgentClientMessageExecResult({      // line 146 — encodes verbatim
  id: pending.id,
  execId: "",
  resultText,
  isError: Boolean(match.isError),
  nativeExecFieldNo: pending.nativeExecFieldNo,
});
// ...
cursorBidiLog("continue.write-mcp-result", {             // line 154
  resultPreview: resultText.slice(0, 120),                // line 157 — shows the stamp!
});
```

The debug output confirms the stamp leaks:

```
[cursor-bidi] continue.write-mcp-result {"mcpResultBytes":149,"streamCloseBytes":4,
"resultPreview":"Bash error: undefined is not an object (evaluating 'command.match')\n\n
<ma::agent::mode-active id=\"ask\" since=\"2026-07-29T..."}
```

**Fix**: `toolResultToWireText()` should strip `<ma::agent:.../>` annotation blocks before sending to Cursor. These are internal MA annotations that Cursor should never see.

---

## Finding 2: Native exec result encoding is incomplete for shell_stream_args (field 14)

`proto/client-message.ts`, lines **52–98**:

```typescript
function encNativeResult(fieldNo: number, opts: ExecMcpResultOpts): Uint8Array {
  if (opts.isError) {
    return encNativeError(fieldNo, opts.resultText);
  }
  switch (fieldNo) {
    case 2:  // shell_args → ShellSuccess
    case 5:  // grep_args → GrepSuccess
    case 7:  // read_args → ReadSuccess
    case 8:  // ls_args → LsSuccess
    default: // ← field 14 ends up HERE
      return opts.isError
        ? encMcpResultError(opts.resultText)
        : encMcpResultSuccess(opts.resultText, false);
  }
}
```

Field **14** (`shell_stream_args`) is absent from the switch cases. It falls through to `default`, which encodes as a generic McpResult — NOT a ShellResult. Cursor expects ShellResult for shell-related exec types.

Similarly, `encNativeError` at lines **100–117**:

```typescript
function encNativeError(fieldNo: number, errorText: string): Uint8Array {
  switch (fieldNo) {
    case 2:  // ShellResult.failure with stderr at field 6
    case 5:  // GrepResult.error
    case 7:  // ReadResult.error
    case 8:  // LsResult.error
    default:  // ← field 14 ends up HERE
      return encMsg(2, encString(1, errorText)); // generic, not ShellResult shape
  }
}
```

For `shell_stream_args` errors, Cursor expects ShellResult.failure with `stderr` at field 6 (like case 2 does). Instead it gets a generic `{field 2: {field 1: "error text"}}` message. Cursor can't parse this and may retry.

### Additional gap: `TOOL_CALL_ID_FIELD` map is missing field 14

`proto/exec-server-decode.ts`, lines **88–92**:

```typescript
const TOOL_CALL_ID_FIELD: ReadonlyMap<number, number> = new Map([
  [2, 4], // shell_args → field 4
  [7, 2], // read_args → field 2
  [8, 3], // ls_args → field 3
]);
```

Field 14 is not in this map. So `extractNativeToolCallId` at line **94** returns `""` for shell_stream_args, forcing a `crypto.randomUUID()` at line **174**. While this doesn't break MA's internal result matching (the UUID is consistent within the session), it discards Cursor's original `tool_call_id`, which could confuse Cursor's tracking.

**Fix**: Add cases for field 14 in `encNativeResult` (mapping to ShellSuccess at field 1), `encNativeError` (mapping to ShellResult.failure at field 2 with stderr at field 6), and `TOOL_CALL_ID_FIELD` (mapping to 4).

---

## Finding 3: Can malformed encoding cause Cursor to fall back to native exec?

**Yes, likely.** When Cursor sends an MCP exec request (field 11) and receives back a result that:

1. Contains unexpected XML annotations (`<ma::agent::mode-active>`),
2. Or is encoded as a native exec type but with the wrong protobuf shape,

Cursor's client interprets this as a protocol error or unexpected output. It then retries the failed tool using a native exec type (field 14 shell_stream_args) as a fallback, presumably because its internal logic says "MCP path produced garbage, try direct shell".

The cycle then repeats with the native path because the native encoding is also broken (Finding 2), and the mode-active stamp still pollutes the result (Finding 1).

---

## Finding 4: `extractTrailingToolResults` matching is NOT the issue

`bidi-run.ts`, lines **124–126**:

```typescript
const results = extractTrailingToolResults(req.messages);
const match =
  results.find((r) => r.toolUseId === pending.toolCallId) ?? results[results.length - 1];
```

The matching logic itself is sound. The `toolUseId` on the result block is set from `tool.id` (tool-round.ts line 897), which originated from `exec.toolCallId` set by `emitExecMcpToolUse` (response-stream-bidi.ts line 218). The `pending.toolCallId` is the same value stored in `pendingExec` at response-stream-bidi.ts line 125. The fallback `results[results.length - 1]` would return the wrong result only if there were multiple tool results in the request and the `toolCallId` match failed. For field 14 with random UUIDs, the matching works because both sides use the same generated value. The fallback would only fire if the `toolCallId` somehow diverged — which doesn't happen in the current code flow.
