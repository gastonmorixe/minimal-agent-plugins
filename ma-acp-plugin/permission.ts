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
 * {@link setActiveGate} / {@link activeGate}.
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
  /** Deny every request that waits now (`session/cancel`). */
  cancelPending(): void
}

export interface CreatePermissionGateOptions {
  readonly request: PermissionRequest
  /** The open ACP session id, or `undefined` before `session/new`. */
  readonly sessionId: () => string | undefined
  readonly deadlineMs?: number
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

function optionName(kind: PermissionOptionKind, toolKind: AcpToolKind): string {
  switch (kind) {
    case "allow_once":
      return "Allow once"
    case "allow_always":
      return `Always allow ${toolKind} tools in this session`
    case "reject_once":
      return "Reject"
    case "reject_always":
      return `Always reject ${toolKind} tools in this session`
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
  const { request, sessionId, deadlineMs = DEFAULT_APPROVAL_DEADLINE_MS, log = () => {} } = options
  const remembered = new Map<AcpToolKind, "allow" | "reject">()
  const waiting = new Set<AbortController>()

  async function ask(payload: ToolWillInvokePayload): Promise<GateResult> {
    const toolKind = toAcpToolKind(toolKindOf(payload.tool))
    const memo = remembered.get(toolKind)
    if (memo === "allow") return undefined
    if (memo === "reject") return deny(`the client rejected ${toolKind} tools for this session`)

    const sid = sessionId()
    if (sid === undefined) return deny("no ACP session is open")

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
            name: optionName(kind, toolKind),
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
        remembered.set(toolKind, "allow")
        return undefined
      case "allow_once":
        return undefined
      case "reject_always":
        remembered.set(toolKind, "reject")
        return deny(
          `the client rejected ${payload.tool} (and all ${toolKind} tools for this session)`,
        )
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
      for (const c of waiting) c.abort(new Error("session cancelled"))
    },
  }
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
