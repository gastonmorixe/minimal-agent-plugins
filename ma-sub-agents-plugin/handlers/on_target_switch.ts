/**
 * `target.didSwitch` event listener: the lead switched its target
 * (credential, provider, model or effort). Each RUNNING worker gets one
 * signed line in its control file, so it can switch in place and keep its
 * work. See `lib/target-control-lead.ts`.
 *
 * A worker follows by its own rule: a worker that the user put on a
 * different credential or provider stays there. This listener only sends.
 */

import type { EventHandlerContext } from "../lib/host-types.ts"
import { resolveSessionsDir } from "../lib/runtime.ts"
import { SubagentStore } from "../lib/store.ts"
import { writeSwitchLines } from "../lib/target-control-lead.ts"

interface Target {
  credentialName?: string
  providerId?: string
  model: string
  effort?: string
}

function asTarget(v: unknown): Target | null {
  if (v === null || typeof v !== "object") return null
  const t = v as Record<string, unknown>
  if (typeof t.model !== "string" || t.model.length === 0) return null
  const text = (x: unknown): string | undefined =>
    typeof x === "string" && x.length > 0 ? x : undefined
  const credentialName = text(t.credentialName)
  const providerId = text(t.providerId)
  const effort = text(t.effort)
  return {
    ...(credentialName !== undefined ? { credentialName } : {}),
    ...(providerId !== undefined ? { providerId } : {}),
    model: t.model,
    ...(effort !== undefined ? { effort } : {}),
  }
}

/** Send the lead's switch (`ctx.payload`: `{from, to}`) to each running worker. */
export default function onTargetSwitch(ctx: EventHandlerContext): void {
  const leadSid = ctx.agent?.sessionId
  if (!leadSid) return
  const payload = (ctx.payload ?? {}) as { from?: unknown; to?: unknown }
  const from = asTarget(payload.from)
  const to = asTarget(payload.to)
  if (!from || !to) return
  const sessionsDir = resolveSessionsDir(ctx.env)
  const records = new SubagentStore(leadSid, { dir: sessionsDir }).all()
  const result = writeSwitchLines(
    records,
    { from, to },
    { sessionsDir, leadSid, now: () => new Date() },
  )
  if (result.sent + result.unreachable + result.failed === 0) return
  const parts = [`${result.sent} running sub-agent(s) got the new target`]
  if (result.unreachable > 0) {
    parts.push(
      `${result.unreachable} keep their old target (they started before this lead process)`,
    )
  }
  if (result.failed > 0) parts.push(`${result.failed} control file(s) could not be written`)
  const text = `target switch: ${parts.join(", ")}`
  if (result.unreachable + result.failed > 0) ctx.log.warn(text)
  else ctx.log.info(text)
}
