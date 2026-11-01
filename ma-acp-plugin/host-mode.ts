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
 * Approval gate (`permission.ts`): OFF by default. `--approval` after
 * `--host-mode acp` turns it on. Then every tool call sends
 * `session/request_permission`, and any failure denies only that call.
 * If core did not load the gate hook (a broken import, or no grant), no
 * tool call can be asked about. Then `session/new` writes a warning to
 * stderr, and every `session/prompt` fails with a JSON-RPC error before
 * the model runs, so no tool runs without approval. The process and the
 * session stay open. `--approval-timeout-ms <n>` sets the gate deadline
 * (default 10 min). A bad value is a startup error: the handler writes it
 * to stderr and returns exit code 2 before it reads stdin.
 *
 * `session/set_config_option` that changes state also pushes
 * `config_option_update` with the complete list. A set to the current
 * value changes nothing and pushes nothing.
 *
 * Deferred: `session/load` / `session/list` / plan / image input.
 *
 * @module host-mode
 */

import { realpathSync } from "node:fs"
import { resolve } from "node:path"

import type {
  HostModeContext,
  HostModeHandler,
  HostSession,
} from "@minimal-agent/core/host-kit/host-mode"

import { buildConfigOptions, setConfigOption } from "./config-options.ts"
import { createSessionEncoder, type SessionEncoder } from "./encoder.ts"
import { clientSupportsNotices } from "./notices.ts"
import {
  createPermissionGate,
  type HostModeArgs,
  HostModeArgsError,
  hookRegistered,
  type PermissionGate,
  parseHostModeArgs,
  setActiveGate,
} from "./permission.ts"
import { createRpcChannel, RPC_ERROR, RpcError } from "./transport.ts"

/** The error text when `--approval` is on but core did not load the gate hook. */
export const GATE_NOT_LOADED =
  "the ACP approval gate failed to load (core skipped the tool.willInvoke hook: see the plugin load log on stderr). --approval is on, so no turn runs: no tool call can be approved"

/** How long the gate waits for the `tool_call` update before it sends the request anyway. */
const TOOL_CALL_SENT_WAIT_MS = 1000

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

/** The params object of a request. Anything else is -32602 (never a TypeError, -32603). */
function paramsObject(raw: unknown, method: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RpcError(RPC_ERROR.invalidParams, `${method}: params must be an object`)
  }
  return raw as Record<string, unknown>
}

/** A string field of `params`, or `undefined` when absent. Other types are -32602. */
function optionalString(params: Record<string, unknown>, key: string, method: string) {
  const v = params[key]
  if (v !== undefined && typeof v !== "string") {
    throw new RpcError(RPC_ERROR.invalidParams, `${method}: ${key} must be a string`)
  }
  return v
}

/**
 * The real path of `dir`, so a symlink and its target compare equal (on
 * macOS, /var/folders/... is a symlink to /private/var/...). A path that
 * does not exist keeps its resolved form.
 */
function samePathKey(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return resolve(dir)
  }
}

const handler: HostModeHandler = async (ctx: HostModeContext): Promise<number> => {
  let session: HostSession | undefined
  let encoder: SessionEncoder | undefined
  let activeRun: AbortController | undefined
  // Stored at `initialize`: send `notice` updates only when the client
  // advertised `clientCapabilities.session.notices`.
  let clientNotices = false
  let args: HostModeArgs
  try {
    args = parseHostModeArgs(ctx.argv)
  } catch (e) {
    if (!(e instanceof HostModeArgsError)) throw e
    ctx.stderr.write(`acp: error: ${e.message}\n`)
    return 2
  }
  if (args.unknown.length > 0)
    ctx.log.warn("acp", `ignored unknown args: ${args.unknown.join(" ")}`)
  if (args.approvalTimeoutSet && !args.approval)
    ctx.log.warn("acp", "--approval-timeout-ms has no effect without --approval")
  // Set at `session/new` only when approval is on.
  let gate: PermissionGate | undefined
  // True when approval is on but core did not load the gate hook.
  let gateNotLoaded = false

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
          const cwd = optionalString(paramsObject(rawParams, "session/new"), "cwd", "session/new")
          if (cwd !== undefined && cwd !== ctx.cwd && samePathKey(cwd) !== samePathKey(ctx.cwd)) {
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
          if (args.approval && !hookRegistered()) {
            gateNotLoaded = true
            ctx.stderr.write(`acp: warning: ${GATE_NOT_LOADED}\n`)
          } else if (args.approval) {
            const enc = encoder
            gate = createPermissionGate({
              request: (method, params, signal) => channel.request(method, params, signal),
              sessionId: () => session?.sessionId,
              deadlineMs: args.approvalTimeoutMs,
              // Send the `tool_call` update before the request. A call inside
              // a worker (`agentId`) has no update in this stream: do not wait.
              beforeRequest: (payload) =>
                payload.agentId === undefined
                  ? enc.toolCallSent(payload.toolUseId, TOOL_CALL_SENT_WAIT_MS)
                  : Promise.resolve(),
              log: (msg) => ctx.log.debug("acp", msg),
            })
            setActiveGate(gate)
          }
          return { sessionId: opened.sessionId, configOptions: buildConfigOptions(ctx.runtime) }
        },
        "session/set_config_option": (rawParams) => {
          const method = "session/set_config_option"
          const params = paramsObject(rawParams, method)
          requireSession(params.sessionId)
          const configId = optionalString(params, "configId", method)
          const before = JSON.stringify(buildConfigOptions(ctx.runtime))
          const configOptions = setConfigOption(ctx.runtime, configId, params.value)
          // Push the new list only when the state changed.
          if (JSON.stringify(configOptions) !== before) encoder?.pushConfigOptions()
          return { configOptions }
        },
        "session/prompt": async (rawParams) => {
          const params = paramsObject(rawParams, "session/prompt")
          const s = requireSession(params.sessionId)
          const input = flattenPrompt(params.prompt)

          const enc = encoder
          if (!enc) throw new RpcError(RPC_ERROR.internal, "session encoder missing")
          if (gateNotLoaded) throw new RpcError(RPC_ERROR.internal, GATE_NOT_LOADED)
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
          // A new turn: clear the deny-all state of an earlier session/cancel.
          gate?.startTurn()
          try {
            let outcome: Parameters<SessionEncoder["finishTurn"]>[0]
            try {
              const run = s.run(input, { emitDeltas: true, signal: controller.signal })
              for await (const entry of run) {
                if (entry.ch === "event") enc.encode(entry.data)
              }
              const settled = (await run.result).outcome
              // ACP: after session/cancel the reply is `cancelled`, also
              // when the run settles "completed" after the abort.
              outcome = controller.signal.aborted ? "aborted" : settled
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
          const sessionId = (rawParams as { sessionId?: unknown } | null | undefined)?.sessionId
          if (session && sessionId === session.sessionId) {
            // ACP: a cancel also answers a waiting permission request. Deny it.
            gate?.cancelPending()
            activeRun?.abort()
          }
        },
      },
    },
  })

  // Shutdown (core's SIGTERM / SIGINT listeners abort `ctx.abort`): stop
  // reading, then finish the same way as at stdin EOF.
  const onAbort = (): void => channel.stop()
  if (ctx.abort.aborted) onAbort()
  else ctx.abort.addEventListener("abort", onAbort, { once: true })

  // EOF or shutdown: abort the active run, wait until every in-flight
  // request has replied (the prompt replies `cancelled`), then close the
  // session so core fires sessionEnd.
  await channel.closed
  ctx.abort.removeEventListener("abort", onAbort)
  activeRun?.abort()
  // A waiting permission request already rejected at EOF / stop(), so the
  // prompt can finish and `idle()` can resolve.
  await channel.idle()
  setActiveGate(undefined)
  if (session) {
    try {
      await session.close()
    } catch (e) {
      ctx.log.warn("acp", `session.close failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return 0
}

export default handler
