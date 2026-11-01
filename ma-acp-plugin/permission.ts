/**
 * The ACP approval gate (`session/request_permission`). OFF by default.
 *
 * minimal-agent runs long autonomous jobs, and no person is assumed. So
 * the default is: send no permission request, and let tools run. The
 * operator turns the gate on with `--approval` after `--host-mode acp`
 * (see {@link parseHostModeArgs} and the plugin README).
 *
 * When the gate is on, it asks the client before EVERY tool call (the ACP
 * spec v3 section 8 names no tool subset). The answer maps as follows:
 * - `allow_once`: run this call.
 * - `allow_always`: run this call, and do not ask again for this tool kind
 *   (`execute`, `edit`, `read`, ...) in this session. Memory only.
 * - `reject_once`: deny this call.
 * - `reject_always`: deny this call, and deny this tool kind from then on
 *   in this session without asking.
 *
 * Kind `other` is the kind of every tool with no named kind (plugin and MCP
 * tools). For kind `other`, the gate keeps the choice per tool NAME, so
 * "always allow" on one such tool does not allow all of them.
 *
 * After `session/cancel`, the gate denies every tool call without a request
 * until the next `session/prompt` ({@link PermissionGate.startTurn}).
 *
 * Every failure denies ONLY that tool call: a thrown or rejected request
 * (closed stdin, `channel.stop()`, a JSON-RPC error), `session/cancel`,
 * outcome `cancelled`, an unknown option id, a malformed answer, and the
 * gate's own deadline. A denial is a hook halt with a reason. Core turns
 * it into a tool error for the model, and the turn continues. The gate
 * never throws. The hook entry is also marked `failClosed` in the
 * manifest, so a bug that throws still denies.
 *
 * The hook module (`permission-hook.ts`) and the host-mode module load as
 * separate entries, but both import this file, so they share
 * {@link setActiveGate} / {@link activeGate}. The hook module also calls
 * {@link setHookRegistered} when it loads. Core skips a hook that fails to
 * load or has no grant, so the host mode reads {@link hookRegistered} to
 * know that the gate can work at all.
 *
 * @module permission
 */

import { toolKindOf } from "@minimal-agent/core/sdk/events"
import type { ToolWillInvokePayload } from "@minimal-agent/core/sdk/lifecycle"

import { type AcpToolKind, toAcpToolKind } from "./encoder.ts"

/** How long the gate waits for an answer before it denies (10 min). */
export const DEFAULT_APPROVAL_DEADLINE_MS = 10 * 60 * 1000

/** ACP `PermissionOptionKind`. The gate uses the kind as the option id too. */
export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always"

const OPTION_KINDS: readonly PermissionOptionKind[] = [
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]

/** A `tool.willInvoke` chain result: `undefined` allows, a halt denies. */
export type GateResult = undefined | { readonly halt: true; readonly reason: string }

/** Same shape as `RpcChannel.request`. */
export type PermissionRequest = (
  method: string,
  params: unknown,
  signal: AbortSignal,
) => Promise<unknown>

export interface PermissionGate {
  /** Ask the client about one tool call. Never throws. */
  check(payload: ToolWillInvokePayload): Promise<GateResult>
  /**
   * `session/cancel`: deny every request that waits now, and deny every
   * later tool call without a request until {@link startTurn}.
   */
  cancelPending(): void
  /** `session/prompt`: a new turn starts. Ask the client again. */
  startTurn(): void
}

export interface CreatePermissionGateOptions {
  readonly request: PermissionRequest
  /** The open ACP session id, or `undefined` before `session/new`. */
  readonly sessionId: () => string | undefined
  readonly deadlineMs?: number
  /**
   * Runs before each request. The host uses it to send the `tool_call`
   * update first, so the client knows the call it is asked about. A throw
   * or rejection is ignored.
   */
  readonly beforeRequest?: (payload: ToolWillInvokePayload) => Promise<void>
  /** Diagnostics only (stderr). */
  readonly log?: (message: string) => void
}

/** What `--host-mode acp <args>` sets. */
export interface HostModeArgs {
  readonly approval: boolean
  /** Args this plugin does not know. They are ignored. */
  readonly unknown: readonly string[]
}

/** Parse `ctx.argv` (the args after `--host-mode acp`). Approval is off unless `--approval` is present. */
export function parseHostModeArgs(argv: readonly string[]): HostModeArgs {
  let approval = false
  const unknown: string[] = []
  for (const arg of argv) {
    if (arg === "--approval") approval = true
    else unknown.push(arg)
  }
  return { approval, unknown }
}

function deny(reason: string): GateResult {
  return { halt: true, reason: `Tool call denied by the ACP approval gate: ${reason}.` }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** What `allow_always` / `reject_always` applies to: a named tool kind, or one tool of kind `other`. */
interface MemoScope {
  /** The key in the remembered map. */
  readonly key: string
  /** For option names and reasons, for example "execute tools" or "the tool mcp__x__y". */
  readonly label: string
}

function memoScope(toolKind: AcpToolKind, toolName: string): MemoScope {
  if (toolKind === "other") return { key: `tool:${toolName}`, label: `the tool ${toolName}` }
  return { key: `kind:${toolKind}`, label: `${toolKind} tools` }
}

function optionName(kind: PermissionOptionKind, scope: MemoScope): string {
  switch (kind) {
    case "allow_once":
      return "Allow once"
    case "allow_always":
      return `Always allow ${scope.label} in this session`
    case "reject_once":
      return "Reject"
    case "reject_always":
      return `Always reject ${scope.label} in this session`
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x)
}

/** The selected option of a `RequestPermissionResponse`, or why the answer is not usable. */
function readOutcome(
  raw: unknown,
): { kind: PermissionOptionKind } | { cancelled: true } | { bad: string } {
  const outcome = isRecord(raw) ? raw.outcome : undefined
  if (!isRecord(outcome)) return { bad: "malformed answer (no outcome object)" }
  if (outcome.outcome === "cancelled") return { cancelled: true }
  if (outcome.outcome !== "selected") return { bad: "malformed answer (unknown outcome)" }
  const id = outcome.optionId
  if (typeof id !== "string") return { bad: "malformed answer (optionId is not a string)" }
  const kind = OPTION_KINDS.find((k) => k === id)
  if (!kind) return { bad: `unknown option id ${JSON.stringify(id)}` }
  return { kind }
}

/** Build one approval gate. Make one per ACP session: remembered choices live in it. */
export function createPermissionGate(options: CreatePermissionGateOptions): PermissionGate {
  const {
    request,
    sessionId,
    deadlineMs = DEFAULT_APPROVAL_DEADLINE_MS,
    beforeRequest,
    log = () => {},
  } = options
  const remembered = new Map<string, "allow" | "reject">()
  const waiting = new Set<AbortController>()
  // Set by `session/cancel`, cleared by the next `session/prompt`.
  let cancelled = false

  async function ask(payload: ToolWillInvokePayload): Promise<GateResult> {
    const toolKind = toAcpToolKind(toolKindOf(payload.tool))
    const scope = memoScope(toolKind, payload.tool)
    if (cancelled) return deny("the client cancelled the turn")
    const memo = remembered.get(scope.key)
    if (memo === "allow") return undefined
    if (memo === "reject") return deny(`the client rejected ${scope.label} for this session`)

    const sid = sessionId()
    if (sid === undefined) return deny("no ACP session is open")

    if (beforeRequest) {
      try {
        await beforeRequest(payload)
      } catch (e) {
        log(`beforeRequest for ${payload.tool} failed: ${describeError(e)}`)
      }
      // A cancel can come while the host sends the tool call.
      if (cancelled) return deny("the client cancelled the turn")
    }

    const controller = new AbortController()
    waiting.add(controller)
    const timer = setTimeout(
      () => controller.abort(new Error(`no answer within ${deadlineMs} ms`)),
      deadlineMs,
    )
    let raw: unknown
    try {
      raw = await request(
        "session/request_permission",
        {
          sessionId: sid,
          toolCall: {
            toolCallId: payload.toolUseId,
            title: payload.tool,
            kind: toolKind,
            status: "pending",
            rawInput: payload.input,
          },
          options: OPTION_KINDS.map((kind) => ({
            optionId: kind,
            name: optionName(kind, scope),
            kind,
          })),
        },
        controller.signal,
      )
    } catch (e) {
      const why = controller.signal.aborted ? controller.signal.reason : e
      log(`request_permission for ${payload.tool} failed: ${describeError(why)}`)
      return deny(`the approval request failed (${describeError(why)})`)
    } finally {
      clearTimeout(timer)
      waiting.delete(controller)
    }

    const answer = readOutcome(raw)
    if ("bad" in answer) return deny(answer.bad)
    if ("cancelled" in answer) return deny("the client cancelled the request")
    switch (answer.kind) {
      case "allow_always":
        remembered.set(scope.key, "allow")
        return undefined
      case "allow_once":
        return undefined
      case "reject_always":
        remembered.set(scope.key, "reject")
        return deny(`the client rejected ${payload.tool} (and ${scope.label} for this session)`)
      case "reject_once":
        return deny(`the client rejected ${payload.tool}`)
    }
  }

  return {
    async check(payload) {
      try {
        return await ask(payload)
      } catch (e) {
        return deny(`the gate failed (${describeError(e)})`)
      }
    },
    cancelPending() {
      cancelled = true
      for (const c of waiting) c.abort(new Error("session cancelled"))
    },
    startTurn() {
      cancelled = false
    },
  }
}

let registered = false

/**
 * Mark that the gate hook module loaded. `permission-hook.ts` calls it
 * with `true` when it loads. Tests can reset it.
 */
export function setHookRegistered(value: boolean): void {
  registered = value
}

/** True when `permission-hook.ts` loaded, so core can call the gate. */
export function hookRegistered(): boolean {
  return registered
}

let current: PermissionGate | undefined

/** Install (or clear, with `undefined`) the gate that `permission-hook.ts` asks. */
export function setActiveGate(gate: PermissionGate | undefined): void {
  current = gate
}

/** The installed gate. `undefined` means approval is off: tools run. */
export function activeGate(): PermissionGate | undefined {
  return current
}
