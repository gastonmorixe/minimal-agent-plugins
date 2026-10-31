/**
 * The ACP `hostModes[].entry` handler: `initialize`, `session/new`,
 * `session/prompt`, `session/cancel`, `session/set_config_option`. Level 1
 * scope (ACP spec section 12 Phase 1) — no fs, no terminal.
 * Builds on `transport.ts` (this plugin's own hand-rolled JSON-RPC). The
 * `session/update` encoding lives in `encoder.ts` (on top of core's shared
 * wire-event mapper, `@minimal-agent/core/sdk/events`), the stop-reason
 * refinement in `stop-reason.ts`, notices in `notices.ts`, and model /
 * effort config options in `config-options.ts`. This file only wires them.
 *
 * ONE session per process (Level 1 / `acp-decisions.md` item 10):
 * `session/new` succeeds exactly once; a second call is a JSON-RPC error.
 *
 * Deferred: `session/load` / `session/list` / plan / image input.
 *
 * @module host-mode
 */

import type {
  HostModeContext,
  HostModeHandler,
  HostSession,
} from "@minimal-agent/core/host-kit/host-mode"

import { buildConfigOptions, setConfigOption } from "./config-options.ts"
import { createSessionEncoder, type SessionEncoder } from "./encoder.ts"
import { clientSupportsNotices } from "./notices.ts"
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

const handler: HostModeHandler = (ctx: HostModeContext): Promise<number> => {
  let session: HostSession | undefined
  let encoder: SessionEncoder | undefined
  let activeRun: AbortController | undefined
  // Stored at `initialize`: send `notice` updates only when the client
  // advertised `clientCapabilities.session.notices`.
  let clientNotices = false

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
        initialize: (rawParams) => {
          clientNotices = clientSupportsNotices(rawParams)
          return {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: false,
              promptCapabilities: { image: false, audio: false, embeddedContext: false },
            },
            agentInfo: { name: "minimal-agent", version: "0.1.0" },
            authMethods: [],
          }
        },
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
          const opened = await ctx.runtime.openSession()
          session = opened
          encoder = createSessionEncoder({
            send: (update) =>
              channel.notify("session/update", { sessionId: opened.sessionId, update }),
            clientNotices,
            runtime: ctx.runtime,
            cwd: ctx.cwd,
          })
          return { sessionId: opened.sessionId, configOptions: buildConfigOptions(ctx.runtime) }
        },
        "session/set_config_option": (rawParams) => {
          const params = rawParams as { sessionId?: string; configId?: unknown; value?: unknown }
          requireSession(params.sessionId)
          return { configOptions: setConfigOption(ctx.runtime, params.configId, params.value) }
        },
        "session/prompt": async (rawParams) => {
          const params = rawParams as { sessionId?: string; prompt?: unknown }
          const s = requireSession(params.sessionId)
          const input = flattenPrompt(params.prompt)

          const enc = encoder
          if (!enc) throw new RpcError(RPC_ERROR.internal, "session encoder missing")
          // Spec v3 Q2b: reject a second prompt while a turn runs, and leave
          // the running turn (and its encoder state) alone.
          if (activeRun) {
            throw new RpcError(
              RPC_ERROR.invalidParams,
              "a turn is already running for this session",
            )
          }
          const controller = new AbortController()
          activeRun = controller
          try {
            let outcome: Parameters<SessionEncoder["finishTurn"]>[0]
            try {
              const run = s.run(input, { emitDeltas: true, signal: controller.signal })
              for await (const entry of run) {
                if (entry.ch === "event") enc.encode(entry.data)
              }
              outcome = (await run.result).outcome
            } catch (e) {
              // ACP: a cancel MUST answer `cancelled`, even when the cancel
              // made the run throw. Any other throw is a failed turn.
              if (!controller.signal.aborted) {
                enc.encode({ type: "error", message: e instanceof Error ? e.message : String(e) })
              }
              outcome = controller.signal.aborted ? "aborted" : "failed"
            }
            const reply = enc.finishTurn(outcome)
            if (reply.kind === "error") throw new RpcError(reply.code, reply.message)
            return reply.result
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

export default handler
