/**
 * Claude Code output decoding: exit codes and JSON stdout to a canonical
 * result. Facts from `research/hooks-claude-vs-codex/raw/claude/hooks-reference.md`
 * (cited as `raw:<line>`).
 *
 * @module adapters/claude/decode
 */

import type { CanonicalResult, HookScope, RunOutcome } from "../../engine/types.ts"

import { type ClaudeEventInfo, claudeEvent, isObj } from "./events.ts"

type Obj = Record<string, unknown>

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

/** Outcome of reading stdout as Claude JSON output (raw:834-838). */
type StdoutRead =
  | { kind: "json"; obj: Obj }
  | { kind: "text"; text: string }
  | { kind: "invalid"; message: string }

/**
 * Classify stdout. One JSON object with only whitespace around it is JSON.
 * Text that does not start with `{`, or does not end with `}`, is plain text.
 * Anything else that starts with `{` and ends with `}` but is not one object
 * is a parse failure (raw:836-838).
 */
export function readClaudeStdout(stdout: string): StdoutRead {
  const t = stdout.trim()
  if (!t.startsWith("{") || !t.endsWith("}")) return { kind: "text", text: t }
  try {
    const v: unknown = JSON.parse(t)
    if (isObj(v)) return { kind: "json", obj: v }
  } catch {
    // fall through
  }
  // Several lines that each parse alone are plain text unless one sets a field (raw:837).
  const lines = t.split("\n").filter((l) => l.trim())
  if (lines.length > 1) {
    let allParse = true
    for (const l of lines) {
      try {
        JSON.parse(l)
      } catch {
        allParse = false
      }
    }
    if (allParse) return { kind: "text", text: t }
  }
  return { kind: "invalid", message: "hook stdout is not valid JSON" }
}

/**
 * Permission decisions. Across hooks, precedence is deny, defer, ask, allow
 * (raw:2017). The engine merge ranks deny, ask, allow, and defer maps to ask.
 */
const PERMISSION: Record<string, CanonicalResult["decision"]> = {
  deny: "deny",
  // `defer` becomes `ask` (SPEC.md), which the engine turns into deny with no host.
  defer: "ask",
  ask: "ask",
  allow: "allow",
}

/** Events whose top-level `decision: "block"` blocks the action (raw:1208). */
const BLOCK_EVENTS = new Set([
  "UserPromptSubmit",
  "PostToolBatch",
  "Stop",
  "SubagentStop",
  "PreCompact",
])

/** Events where `decision: "block"` only adds the reason next to the tool result (raw:2327). */
const FEEDBACK_EVENTS = new Set(["PostToolUse", "PostToolUseFailure"])

/** Events that accept `additionalContext` (raw:1176-1182, raw:1219). */
const CONTEXT_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "SessionStart",
  "SubagentStart",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
])

/** Events that discard `systemMessage` and `continue` (raw:2647, raw:3425, raw:3689). */
const DISCARD_UNIVERSAL = new Set(["Notification", "PostCompact", "SessionEnd"])

function contextOf(event: string, hso: Obj | undefined): string[] {
  if (!hso || !CONTEXT_EVENTS.has(event)) return []
  const c = hso.additionalContext
  return typeof c === "string" && c.trim() ? [c] : []
}

/** Decode one Claude JSON output object for an event. */
export function decodeClaudeJson(event: string, obj: Obj): CanonicalResult {
  const hso = isObj(obj.hookSpecificOutput) ? obj.hookSpecificOutput : undefined
  const r: CanonicalResult = { decision: "none", context: contextOf(event, hso) }
  if (!DISCARD_UNIVERSAL.has(event)) {
    // `continue: false` stops processing, `stopReason` is shown (raw:1106-1107).
    if (obj.continue === false)
      r.stopTurn = str(obj.stopReason) ? { reason: obj.stopReason as string } : {}
    // `systemMessage` is a warning for the user (raw:1109).
    if (str(obj.systemMessage)) r.userMessage = obj.systemMessage as string
  }
  // `suppressOutput` "Has no effect" (raw:1108): accepted and ignored.
  const reason = str(obj.reason)
  if (event === "PreToolUse") {
    const pd = hso ? str(hso.permissionDecision) : undefined
    // Deprecated top-level `approve`/`block` map to allow/deny (raw:2039).
    const legacy =
      obj.decision === "approve" ? "allow" : obj.decision === "block" ? "deny" : undefined
    const d = pd ? PERMISSION[pd] : legacy
    if (d) r.decision = d
    const why = (hso ? str(hso.permissionDecisionReason) : undefined) ?? reason
    if (why) r.reason = why
    // `updatedInput` replaces the whole input; ignored for `defer` (raw:2014).
    if (hso && isObj(hso.updatedInput) && pd !== "defer" && r.decision !== "deny") {
      r.payload = { input: hso.updatedInput }
    }
    if (pd === "defer") r.context = []
    return r
  }
  if (obj.decision === "block") {
    if (BLOCK_EVENTS.has(event)) {
      r.decision = "deny"
      r.reason = reason ?? "Blocked by hook."
    } else if (FEEDBACK_EVENTS.has(event) && reason) {
      r.context = [reason, ...r.context]
    }
  }
  // Stop/SubagentStop additionalContext keeps the conversation going (raw:2916, raw:2927).
  if ((event === "Stop" || event === "SubagentStop") && r.decision !== "deny" && r.context.length) {
    r.decision = "deny"
    r.reason = r.context.join("\n")
    r.context = []
  }
  return r
}

/** Stderr text that says a file is missing (raw:824, raw:890-893). */
const MISSING_FILE = /no such file or directory/i

/**
 * Exit 2 with nothing on stdout and a "file is missing" stderr is a
 * non-blocking error on Stop, SubagentStop, TaskCompleted, and a plugin's
 * UserPromptSubmit (raw:824). The hook never ran (raw:890-893).
 */
function missingScript(event: string, run: RunOutcome, scope: HookScope | undefined): boolean {
  if (run.stdout.trim() !== "" || !MISSING_FILE.test(run.stderr)) return false
  if (event === "Stop" || event === "SubagentStop" || event === "TaskCompleted") return true
  return event === "UserPromptSubmit" && scope === "plugin"
}

function exit2(
  info: ClaudeEventInfo,
  event: string,
  run: RunOutcome,
  scope?: HookScope,
): CanonicalResult {
  const stderr = run.stderr.trim()
  if (missingScript(event, run, scope)) {
    const line = stderr.split("\n")[0] ?? ""
    return { decision: "none", context: [], error: `exit 2: ${line.slice(0, 500)}` }
  }
  const read = readClaudeStdout(run.stdout)
  // JSON is still read but cannot override the block (raw:851-855).
  const json = read.kind === "json" ? decodeClaudeJson(event, read.obj) : undefined
  if (info.exit2 === "block") {
    const jsonReason = json?.decision === "deny" ? json.reason : undefined
    return {
      decision: "deny",
      reason: jsonReason ?? (stderr || "Blocked by hook."),
      context: json?.context ?? [],
    }
  }
  // Notification and InstructionsLoaded: exit 2 is ignored (raw:1048, raw:1064).
  if (info.exit2 === "ignore") return { decision: "none", context: [] }
  // PostToolUse / PostToolUseFailure: stderr goes to the model (raw:1044-1045).
  if (info.exit2 === "model") return { decision: "none", context: stderr ? [stderr] : [] }
  // Other non-blocking events: stderr is shown to the user only (raw:1049-1057).
  return { decision: "none", context: [], ...(stderr ? { userMessage: stderr } : {}) }
}

/**
 * Map a run outcome to a canonical result for one Claude event (raw:806-818).
 * Never throws.
 */
export function decodeClaudeOutcome(
  event: string,
  run: RunOutcome,
  failClosed: boolean,
  scope?: HookScope,
): CanonicalResult {
  const info = claudeEvent(event)
  if (!info) return { decision: "none", context: [], error: `unsupported event ${event}` }
  if (run.timedOut || run.exitCode === null) {
    return { decision: "none", context: [], error: run.error ?? "hook did not exit" }
  }
  if (run.exitCode === 2) return exit2(info, event, run, scope)
  const read = readClaudeStdout(run.stdout)
  if (run.exitCode !== 0) {
    // Valid JSON with another exit code: the fields decide, unless onFailure is block (raw:816).
    if (read.kind === "json" && !failClosed) return decodeClaudeJson(event, read.obj)
    const tail = run.stderr.trim().split("\n")[0] ?? ""
    return {
      decision: "none",
      context: [],
      error: `exit ${run.exitCode}${tail ? `: ${tail.slice(0, 500)}` : ""}`,
    }
  }
  if (read.kind === "json") return decodeClaudeJson(event, read.obj)
  // Unparsable JSON on exit 0 is a non-blocking error (raw:832).
  if (read.kind === "invalid") return { decision: "none", context: [], error: read.message }
  if (read.text === "") return { decision: "none", context: [] }
  return { decision: "none", context: info.plainTextContext ? [read.text] : [] }
}
