/**
 * `message.willSend`: print the outgoing request as JSON, then halt the send.
 *
 * Runs at the lowest priority, so it sees the payload after every other
 * listener (for example a redaction hook) has changed it.
 *
 * - Conversation sends: dump the snapshot, then halt.
 * - Compaction, title and quota sends: halt with no dump (no network).
 *
 * Output target: `MINIMAL_AGENT_DRY_RUN_OUT` (a file path), stderr when the
 * value is `stderr`, or stdout when the variable is unset or `-`.
 *
 * @module handlers/dump_and_halt
 */

import { writeFileSync, writeSync } from "node:fs"

/** Subset of the core SendSnapshot this handler reads. */
export interface SendSnapshot {
  messages: unknown[]
  system: string | Array<{ type: string; text?: string }>
  model: string
  providerId?: string
  request?: {
    requestType?: "quota" | "title" | "conversation"
    tools?: ReadonlyArray<{ name: string; description: string; input_schema: unknown }>
    maxTokens?: number
    thinking?: unknown
    outputConfig?: unknown
    temperature?: number
  }
  compact?: boolean
}

/** Subset of the core hook handler context this handler reads. */
export interface HandlerContext {
  env?: Record<string, string | undefined>
}

/** Chain result that vetoes the send. */
export interface HaltResult {
  halt: true
  reason: string
}

/** The JSON document the handler writes. */
export interface DryRunDump {
  dryRun: true
  model: string
  providerId?: string
  system: SendSnapshot["system"]
  messages: unknown[]
  request: NonNullable<SendSnapshot["request"]> | null
}

/** Reason shown when the send is blocked. */
export const HALT_REASON = "dry-run: request built and printed, not sent"

/** True when the snapshot is a normal conversation send (worth dumping). */
export function isConversationSend(p: SendSnapshot): boolean {
  if (p.compact === true) return false
  const t = p.request?.requestType
  return t === undefined || t === "conversation"
}

/** Build the JSON document for one snapshot. */
export function toDump(p: SendSnapshot): DryRunDump {
  return {
    dryRun: true,
    model: p.model,
    ...(p.providerId !== undefined ? { providerId: p.providerId } : {}),
    system: p.system,
    messages: p.messages,
    request: p.request ?? null,
  }
}

/** Where the dump goes: a file descriptor (1 stdout, 2 stderr) or a file path. */
export type DumpTarget = { kind: "fd"; fd: 1 | 2 } | { kind: "file"; path: string }

/**
 * Resolve `MINIMAL_AGENT_DRY_RUN_OUT` to a target. Unset, empty, or `-`:
 * stdout. `stderr`: fd 2 (the CLI sets this on the JSON output routes, so
 * stdout stays valid JSONL). Any other value: a file path.
 */
export function resolveTarget(out: string | undefined): DumpTarget {
  if (out === undefined || out === "" || out === "-") return { kind: "fd", fd: 1 }
  if (out === "stderr") return { kind: "fd", fd: 2 }
  return { kind: "file", path: out }
}

/** Write text to the configured target. Synchronous so nothing is lost on exit. */
function emit(text: string, out: string | undefined): void {
  const target = resolveTarget(out)
  if (target.kind === "fd") {
    writeSync(target.fd, text)
    return
  }
  writeFileSync(target.path, text)
}

/**
 * HookBus `message.willSend` handler (default export for the manifest).
 *
 * @param payload - Outgoing send snapshot.
 * @param ctx - Hook context. `ctx.env` carries the process env.
 * @returns A halt result. The send never reaches the transport.
 */
export default function dumpAndHalt(payload: SendSnapshot, ctx?: HandlerContext): HaltResult {
  if (isConversationSend(payload)) {
    const env = ctx?.env ?? process.env
    emit(`${JSON.stringify(toDump(payload), null, 2)}\n`, env.MINIMAL_AGENT_DRY_RUN_OUT)
  }
  return { halt: true, reason: HALT_REASON }
}
