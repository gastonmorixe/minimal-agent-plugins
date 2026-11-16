/**
 * Claude Code event table and stdin encoding.
 *
 * The event to channel map is SPEC.md "Claude Code adapter". Claude facts
 * come from `research/hooks-claude-vs-codex/raw/claude/hooks-reference.md`
 * (cited as `raw:<line>`). Imports only the engine's canonical types.
 *
 * @module adapters/claude/events
 */

import type { InvocationContext } from "../../engine/types.ts"

type Obj = Record<string, unknown>

/** True for a plain object. */
export function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** How exit 2 acts on one event (raw:1031-1065). */
export type Exit2Effect = "block" | "model" | "user" | "ignore"

/** One supported Claude event. */
export interface ClaudeEventInfo {
  channel: string
  /** The value the matcher tests, or undefined when the event has no matcher (raw:297-317). */
  matchValue?: (payload: Obj) => string | undefined
  /** Extra filter that splits a shared channel (SPEC.md event map). */
  accepts?: (payload: Obj) => boolean
  exit2: Exit2Effect
  /** Plain stdout on exit 0 becomes context (raw:842-843). */
  plainTextContext: boolean
  /** A tool event: `if` is evaluated (raw:428). */
  toolEvent: boolean
  /** The event's stdin carries `permission_mode` (per the JSON examples, raw:763). */
  permissionMode: boolean
  /** Default timeout in ms (raw:429). */
  defaultTimeoutMs: number
}

const T600 = 600_000
const T30 = 30_000

/** PreCompact/PostCompact trigger: core `exceeded` maps to `auto` (SPEC.md). */
export function compactTrigger(reason: unknown): string | undefined {
  if (reason === "exceeded") return "auto"
  return str(reason)
}

const tool = (p: Obj) => str(p.tool)

/** Supported Claude events. Every other name is `unsupported-event`. */
export const CLAUDE_EVENTS: Readonly<Record<string, ClaudeEventInfo>> = {
  SessionStart: {
    channel: "session.willStart",
    matchValue: (p) => str(p.source),
    exit2: "user",
    plainTextContext: true,
    toolEvent: false,
    permissionMode: false,
    defaultTimeoutMs: T600,
  },
  UserPromptSubmit: {
    channel: "turn.willStart",
    exit2: "block",
    plainTextContext: true,
    toolEvent: false,
    permissionMode: true,
    defaultTimeoutMs: T30,
  },
  PreToolUse: {
    channel: "tool.willInvoke",
    matchValue: tool,
    exit2: "block",
    plainTextContext: false,
    toolEvent: true,
    permissionMode: true,
    defaultTimeoutMs: T600,
  },
  PostToolUse: {
    channel: "tool.didInvoke",
    matchValue: tool,
    accepts: (p) => p.isError !== true,
    exit2: "model",
    plainTextContext: false,
    toolEvent: true,
    permissionMode: true,
    defaultTimeoutMs: T600,
  },
  PostToolUseFailure: {
    channel: "tool.didInvoke",
    matchValue: tool,
    accepts: (p) => p.isError === true,
    exit2: "model",
    plainTextContext: false,
    toolEvent: true,
    permissionMode: true,
    defaultTimeoutMs: T600,
  },
  PostToolBatch: {
    channel: "tool.didBatch",
    exit2: "block",
    plainTextContext: false,
    toolEvent: false,
    permissionMode: true,
    defaultTimeoutMs: T600,
  },
  Stop: {
    channel: "turn.willStop",
    accepts: (p) => !str(p.agentId),
    exit2: "block",
    plainTextContext: false,
    toolEvent: false,
    permissionMode: true,
    defaultTimeoutMs: T600,
  },
  SubagentStop: {
    channel: "turn.willStop",
    // Unverified: the core payload has no agent type yet, `agentType` is read when present.
    matchValue: (p) => str(p.agentType),
    accepts: (p) => !!str(p.agentId),
    exit2: "block",
    plainTextContext: false,
    toolEvent: false,
    permissionMode: true,
    defaultTimeoutMs: T600,
  },
  SubagentStart: {
    channel: "subagent.willSpawn",
    matchValue: (p) => str(p.type),
    exit2: "user",
    plainTextContext: false,
    toolEvent: false,
    permissionMode: false,
    defaultTimeoutMs: T600,
  },
  PreCompact: {
    channel: "compact.willRun",
    matchValue: (p) => compactTrigger(p.reason),
    exit2: "block",
    plainTextContext: true,
    toolEvent: false,
    permissionMode: false,
    defaultTimeoutMs: T600,
  },
  PostCompact: {
    channel: "compact.didRun",
    matchValue: (p) => compactTrigger(p.reason),
    exit2: "user",
    plainTextContext: false,
    toolEvent: false,
    permissionMode: false,
    defaultTimeoutMs: T600,
  },
  SessionEnd: {
    channel: "agent.willStop",
    matchValue: (p) => str(p.reason) ?? "other",
    exit2: "user",
    plainTextContext: false,
    toolEvent: false,
    permissionMode: false,
    defaultTimeoutMs: T600,
  },
  CwdChanged: {
    channel: "cwd.didChange",
    exit2: "user",
    plainTextContext: false,
    toolEvent: false,
    permissionMode: false,
    defaultTimeoutMs: T600,
  },
  InstructionsLoaded: {
    channel: "instructions.didLoad",
    // Unverified: core payload field names for the load reason.
    matchValue: (p) => str(p.loadReason) ?? str(p.reason),
    // "Exit code is ignored" (raw:1064).
    exit2: "ignore",
    plainTextContext: false,
    toolEvent: false,
    permissionMode: false,
    defaultTimeoutMs: T600,
  },
  Notification: {
    channel: "notification.emit",
    // Unverified: core notification payload type.
    matchValue: (p) => str(p.notificationType) ?? str(p.type),
    // "Exit code and stderr are ignored" (raw:1048).
    exit2: "ignore",
    plainTextContext: false,
    toolEvent: false,
    permissionMode: false,
    defaultTimeoutMs: T600,
  },
}

/** Info for a supported event, else undefined. */
export function claudeEvent(name: string): ClaudeEventInfo | undefined {
  return Object.hasOwn(CLAUDE_EVENTS, name) ? CLAUDE_EVENTS[name] : undefined
}

/**
 * Map a minimal-agent mode id to Claude `permission_mode` (SPEC.md:
 * `default` to `default`, `ask` to `plan`, else the native id). No mode
 * gives `default`.
 */
export function claudePermissionMode(agentMode: string | undefined): string {
  if (!agentMode || agentMode === "default") return "default"
  if (agentMode === "ask") return "plan"
  return agentMode
}

/** Event-specific stdin fields (raw:780-802 and each event's input section). */
function eventFields(event: string, p: Obj): Obj {
  switch (event) {
    case "PreToolUse":
      return { tool_name: p.tool, tool_input: p.input ?? {}, tool_use_id: p.toolUseId }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const out: Obj = { tool_name: p.tool, tool_input: p.input ?? {} }
      if (p.toolUseId !== undefined) out.tool_use_id = p.toolUseId
      // Unverified: the core tool.didInvoke payload has no tool result yet.
      const response = p.result ?? p.output
      if (event === "PostToolUse" && response !== undefined) out.tool_response = response
      if (event === "PostToolUseFailure") out.error = str(p.error) ?? ""
      return out
    }
    case "PostToolBatch": {
      // raw:2456-2479. Core items carry {tool, toolUseId, ok} only.
      const items = Array.isArray(p.results) ? p.results : []
      return {
        tool_calls: items.filter(isObj).map((r) => ({
          tool_name: r.tool,
          tool_input: r.input ?? {},
          tool_use_id: r.toolUseId,
        })),
      }
    }
    case "UserPromptSubmit":
      return { prompt: str(p.text) ?? "" }
    case "Stop":
    case "SubagentStop":
      // raw:2846, raw:2691.
      return {
        stop_hook_active: p.stopHookActive === true,
        last_assistant_message: str(p.lastAssistantText) ?? "",
      }
    case "SessionStart":
      // raw:1308-1313.
      return { source: p.source, ...(str(p.model) ? { model: p.model } : {}) }
    case "SubagentStart":
      return { agent_type: str(p.type) ?? "" }
    case "PreCompact":
      return { trigger: compactTrigger(p.reason), custom_instructions: null }
    case "PostCompact":
      return { trigger: compactTrigger(p.reason) }
    case "SessionEnd":
      return { reason: str(p.reason) ?? "other" }
    case "CwdChanged":
      return { old_cwd: p.from, new_cwd: p.to }
    case "InstructionsLoaded":
      return {
        ...(str(p.filePath) ? { file_path: p.filePath } : {}),
        ...(str(p.loadReason) ? { load_reason: p.loadReason } : {}),
      }
    case "Notification":
      return {
        message: str(p.message) ?? "",
        ...(str(p.title) ? { title: p.title } : {}),
        notification_type: str(p.notificationType) ?? str(p.type) ?? "",
      }
    default:
      return {}
  }
}

/** Build the Claude stdin object (common fields raw:756-772, plus event fields). */
export function claudeStdin(event: string, payload: unknown, ctx: InvocationContext): Obj {
  const p = isObj(payload) ? payload : {}
  const info = claudeEvent(event)
  const out: Obj = { session_id: ctx.sid }
  if (ctx.transcriptPath) out.transcript_path = ctx.transcriptPath
  out.cwd = ctx.cwd
  if (info?.permissionMode) out.permission_mode = claudePermissionMode(ctx.agentMode)
  out.hook_event_name = event
  const agentId = ctx.agentId ?? str(p.agentId)
  if (agentId) out.agent_id = agentId
  const agentType = str(p.agentType)
  if (agentType) out.agent_type = agentType
  return { ...out, ...eventFields(event, p) }
}
