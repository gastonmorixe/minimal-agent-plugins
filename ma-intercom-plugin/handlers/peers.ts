/**
 * `Peers` — read-only presence + cross-plugin inspection of other sessions.
 *
 *   - `list`    → the live roster (who's running, liveness, model, cwd).
 *   - `inspect` → a deep dive on ONE peer, aggregating its tasks, background
 *     jobs, sub-agent fleet, recent activity, and a transcript excerpt — pulled
 *     from each owner plugin's per-session sidecar (and the host sessions:read
 *     capability) WITHOUT importing those plugins.
 *
 * @module handlers/peers
 */

import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { livenessLabel } from "../lib/liveness.ts"
import {
  renderInspectDisplay,
  renderInspectText,
  renderRosterDisplay,
  renderRosterText,
} from "../lib/render.ts"
import { rosterCounts } from "../lib/roster.ts"
import {
  ALL_INSPECT_SECTIONS,
  type InspectSection,
  inspectPeer,
  loadRoster,
  resolvePeer,
  serviceDepsFromAgent,
} from "../lib/service.ts"
import { bold, cyan, dim, gray } from "../lib/style.ts"

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
}

const ICON = "⇆"
const VALID_SECTIONS = new Set<InspectSection>(ALL_INSPECT_SECTIONS)
/** Default inspect sections when the caller doesn't specify (cheap + most useful). */
const DEFAULT_SECTIONS: readonly InspectSection[] = ["tasks", "activity", "jobs"]

/** Tool handler for `Peers`. */
export default async function peersHandler(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "Peers: unexpected trigger", is_error: true }
  }
  const input = ctx.trigger.input
  const deps = serviceDepsFromAgent(ctx.agent, ctx.env)
  if (!deps) {
    return {
      kind: "tool_result",
      content: "Peers: no session id available; intercom is inactive for this run.",
      is_error: true,
    }
  }
  const action = str(input.action) ?? "list"
  const asJson = str(input.format) === "json"

  if (action === "list") {
    const liveOnly = input.liveOnly === true
    const rows = loadRoster(deps, { excludeSelf: false, ...(liveOnly ? { liveOnly: true } : {}) })
    const counts = rosterCounts(rows)
    if (asJson) {
      const payload = rows.map((r) => ({
        short: r.record.short,
        sid: r.record.sid,
        self: r.isSelf,
        liveness: livenessLabel(r.liveness),
        model: r.record.model,
        cwd: r.record.cwd,
        phase: r.liveness.status === "online" ? r.liveness.phase : undefined,
        activity: r.record.activity,
        ageMs: r.liveness.ageMs,
      }))
      return {
        kind: "tool_result",
        content: JSON.stringify({ peers: payload, counts }, null, 2),
        displayHeader: `${cyan(ICON)} ${bold("peers")} ${dim("·")} ${gray(`${counts.total} peer(s)`)}`,
      }
    }
    return {
      kind: "tool_result",
      content: renderRosterText(rows, counts),
      displayHeader: `${cyan(ICON)} ${bold("peers")} ${dim("·")} ${gray(`${counts.total} peer(s)`)}`,
      display: renderRosterDisplay(rows),
    }
  }

  if (action === "inspect") {
    const peerRef = str(input.peer)
    if (!peerRef) {
      return {
        kind: "tool_result",
        content: "Peers inspect: `peer` is required (a short id or full sid).",
        is_error: true,
      }
    }
    const res = resolvePeer(deps, peerRef)
    if (!res.ok) {
      const msg =
        res.reason === "ambiguous"
          ? `Ambiguous peer "${peerRef}": matches ${res.candidates.join(", ")}. Use a longer id.`
          : res.reason === "self"
            ? `"${peerRef}" is you. Inspect a different session.`
            : `No peer matches "${peerRef}". Run Peers list to see who's around.`
      return { kind: "tool_result", content: msg, is_error: true }
    }
    const include = resolveSections(input.include)
    const bundle = await inspectPeer(deps, res.row.record, include, ctx.host?.sessions)
    if (asJson) {
      return {
        kind: "tool_result",
        content: JSON.stringify(bundle, null, 2),
        displayHeader: `${cyan(ICON)} ${bold("inspect")} ${dim("·")} ${gray(res.row.record.short)}`,
        display: renderInspectDisplay(bundle),
      }
    }
    return {
      kind: "tool_result",
      content: renderInspectText(bundle),
      displayHeader: `${cyan(ICON)} ${bold("inspect")} ${dim("·")} ${gray(res.row.record.short)}`,
      display: renderInspectDisplay(bundle),
    }
  }

  return {
    kind: "tool_result",
    content: `Peers: unknown action ${JSON.stringify(action)} (use list | inspect).`,
    is_error: true,
  }
}

/** Resolve the `include` array into a validated section set, defaulting sensibly. */
function resolveSections(raw: unknown): Set<InspectSection> {
  if (!Array.isArray(raw) || raw.length === 0) return new Set(DEFAULT_SECTIONS)
  const out = new Set<InspectSection>()
  for (const v of raw) {
    if (typeof v === "string" && VALID_SECTIONS.has(v as InspectSection))
      out.add(v as InspectSection)
  }
  return out.size > 0 ? out : new Set(DEFAULT_SECTIONS)
}
