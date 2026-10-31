/**
 * The ACP `hostModes[].entry` handler: `initialize`, `session/new`,
 * `session/prompt`, `session/cancel`. Level 1 scope only (ACP spec section
 * 12 Phase 1) — no fs, no terminal, no permission gate, no configOptions.
 * Builds on `transport.ts` (this plugin's own hand-rolled JSON-RPC) and
 * core's shared wire-event mapper (`@minimal-agent/core/sdk/events`,
 * `toWireMessageDelta`/`toWireToolStarted`/etc. and `deriveStopCause`),
 * never a vendored copy of that mapping logic.
 *
 * ONE session per process (Level 1 / `acp-decisions.md` item 10):
 * `session/new` succeeds exactly once; a second call is a JSON-RPC error.
 *
 * Deferred past this pass (see the session report): the approval gate
 * (section 8, `session/request_permission`), `configOptions` / model and
 * effort switching (section 10b — blocked on `AgentCore.setEffort`, not
 * landed as of this file), the richer ACP-specific stop-reason refinement
 * (section 4a: `pause_turn` / `context_window_exceeded` / a completed-turn
 * `error`), the real notice-capability check (this build always falls
 * back to `agent_message_chunk` rather than a real `notice` update), and
 * `session/load` / `session/list` / plan / image input.
 *
 * @module host-mode
 */

import type {
  HostModeContext,
  HostModeHandler,
  HostSession,
} from "@minimal-agent/core/host-kit/host-mode"
import type { AgentEvent } from "@minimal-agent/core/sdk/events"
import {
  deriveStopCause,
  toWireMessageDelta,
  toWireToolFinished,
  toWireToolStarted,
  type WireStopCause,
} from "@minimal-agent/core/sdk/events"
import type { TurnNotice } from "@minimal-agent/core/sdk/turn-notice"

import { createRpcChannel, RPC_ERROR, RpcError } from "./transport.ts"

interface ContentBlock {
  readonly type: string
  readonly text?: string
  readonly uri?: string
}

/** Level 1: flatten `text` and `resource_link` blocks to one string. Anything else is -32602. */
function flattenPrompt(blocks: unknown): string {
  if (!Array.isArray(blocks)) throw new RpcError(RPC_ERROR.invalidParams, "prompt must be an array")
  const parts: string[] = []
  for (const raw of blocks as unknown[]) {
    const b = raw as ContentBlock
    if (b?.type === "text" && typeof b.text === "string") {
      parts.push(b.text)
    } else if (b?.type === "resource_link" && typeof b.uri === "string") {
      parts.push(`[resource: ${b.uri}]`)
    } else {
      throw new RpcError(
        RPC_ERROR.invalidParams,
        `unsupported prompt block type "${b?.type ?? "undefined"}" (Level 1 accepts text and resource_link only)`,
      )
    }
  }
  return parts.join("")
}

/** Maps a `WireStopCause` to an ACP `stopReason`, or a JSON-RPC error to raise instead of replying. */
function stopCauseToAcp(cause: WireStopCause): { stopReason: string } | { rpcError: Error } {
  switch (cause.kind) {
    case "completed":
      return { stopReason: "end_turn" }
    case "refused":
      return { stopReason: "refusal" }
    case "truncated":
      return { stopReason: cause.reason === "max_tokens" ? "max_tokens" : "end_turn" }
    case "aborted":
      return { stopReason: "cancelled" }
    case "failed":
      return { rpcError: new RpcError(RPC_ERROR.internal, cause.message) }
    case "waiting":
      return {
        rpcError: new RpcError(RPC_ERROR.internal, "the run paused after a permanent error"),
      }
    default: {
      const _exhaustive: never = cause
      throw new Error(`unhandled stop cause: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

const handler: HostModeHandler = (ctx: HostModeContext): Promise<number> => {
  let session: HostSession | undefined
  let activeRun: AbortController | undefined

  const requireSession = (sessionId: unknown): HostSession => {
    if (!session || session.sessionId !== sessionId) {
      throw new RpcError(RPC_ERROR.invalidParams, `unknown session: ${String(sessionId)}`)
    }
    return session
  }

  const channel = createRpcChannel({
    stdin: ctx.stdin,
    write: (line) => {
      ctx.stdout.write(line)
    },
    log: (msg) => ctx.log.debug("acp", msg),
    handlers: {
      requests: {
        initialize: () => ({
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
          agentInfo: { name: "minimal-agent", version: "0.1.0" },
          authMethods: [],
        }),
        "session/new": async (rawParams) => {
          if (session) {
            throw new RpcError(
              RPC_ERROR.invalidRequest,
              "a session is already open for this process (Level 1 is one session per process)",
            )
          }
          const params = rawParams as { cwd?: string }
          if (params.cwd !== undefined && params.cwd !== ctx.cwd) {
            throw new RpcError(
              RPC_ERROR.invalidParams,
              `this process is fixed to cwd ${ctx.cwd}; a session with another cwd needs its own process`,
            )
          }
          session = await ctx.runtime.openSession()
          return { sessionId: session.sessionId }
        },
        "session/prompt": async (rawParams) => {
          const params = rawParams as { sessionId?: string; prompt?: unknown }
          const s = requireSession(params.sessionId)
          const input = flattenPrompt(params.prompt)

          const controller = new AbortController()
          activeRun = controller
          let lastNotice: TurnNotice | null = null
          let lastError: { message: string; code?: string } | null = null
          try {
            const run = s.run(input, { emitDeltas: true, signal: controller.signal })
            for await (const entry of run) {
              if (entry.ch !== "event") continue
              emitUpdate(channel, s.sessionId, entry.data, (n) => {
                lastNotice = n
              })
              if (entry.data.type === "error") {
                lastError = {
                  message: entry.data.message,
                  ...(entry.data.code ? { code: entry.data.code } : {}),
                }
              }
            }
            const result = await run.result
            const cause = deriveStopCause({ outcome: result.outcome, lastNotice, lastError })
            const mapped = stopCauseToAcp(cause)
            if ("rpcError" in mapped) throw mapped.rpcError
            return { stopReason: mapped.stopReason }
          } finally {
            if (activeRun === controller) activeRun = undefined
          }
        },
      },
      notifications: {
        "session/cancel": (rawParams) => {
          const params = rawParams as { sessionId?: string }
          if (session && params.sessionId === session.sessionId) activeRun?.abort()
        },
      },
    },
  })

  return channel.closed.then(() => 0)
}

/** Project one `AgentEvent` to zero or more ACP `session/update` notifications. */
function emitUpdate(
  channel: ReturnType<typeof createRpcChannel>,
  sessionId: string,
  event: AgentEvent,
  onNotice: (n: TurnNotice) => void,
): void {
  const send = (update: Record<string, unknown>): void => {
    channel.notify("session/update", { sessionId, update })
  }
  switch (event.type) {
    case "text_delta":
    case "thinking_delta": {
      const wire = toWireMessageDelta(event)
      send({
        sessionUpdate: wire.channel === "answer" ? "agent_message_chunk" : "agent_thought_chunk",
        messageId: wire.messageId,
        content: { type: "text", text: wire.text },
      })
      return
    }
    case "tool_call": {
      const wire = toWireToolStarted(event)
      send({
        sessionUpdate: "tool_call",
        toolCallId: wire.toolCallId,
        title: wire.toolName,
        status: "pending",
        rawInput: wire.input,
      })
      return
    }
    case "tool_result": {
      const wire = toWireToolFinished(event)
      send({
        sessionUpdate: "tool_call_update",
        toolCallId: wire.toolCallId,
        status: wire.status === "succeeded" ? "completed" : "failed",
      })
      return
    }
    case "notice":
      // Level 1 simplification: always the agent_message_chunk fallback,
      // never a real `notice` update (that needs the client's
      // session.notices capability, tracked from session/new — deferred).
      send({
        sessionUpdate: "agent_message_chunk",
        messageId: "notice",
        content: { type: "text", text: formatNoticePlain(event.notice) },
      })
      onNotice(event.notice)
      return
    default:
      return
  }
}

function formatNoticePlain(notice: TurnNotice): string {
  return `[${notice.severity}] ${notice.kind}`
}

export default handler
