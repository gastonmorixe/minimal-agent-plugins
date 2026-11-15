/**
 * Model-facing plain-text for the tool results (the `content` field). Distinct
 * from the ANSI `display` chrome: this is what the LEAD model reads, so it is
 * compact, parseable, and bounded — never a worker's full transcript.
 *
 * @module sub-agents/lib/content
 */

import { fmtElapsed, fmtSpend } from "./style.ts"
import { fleetStats, type Progress, type SubagentRecord, type SubagentStatus } from "./types.ts"

/** `· 4 turns` / `· 2 failed` / `· 1m12`, the stream facts a status line adds. */
function streamFacts(c: { turns?: number; toolErrors?: number; durationMs?: number }): string {
  const parts: string[] = []
  if (c.toolErrors) parts.push(`${c.toolErrors} failed`)
  if (c.turns) parts.push(`${c.turns} turns`)
  if (c.durationMs && c.durationMs >= 1000) parts.push(`took ${fmtElapsed(c.durationMs)}`)
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : ""
}

/** The live "doing now" phrase of a running worker (stream telemetry). */
function nowDoing(p: Progress, nowMs: number): string {
  switch (p.phase) {
    case "starting":
      return " · starting"
    case "thinking":
      return " · thinking"
    case "writing":
      return " · writing its answer"
    case "tool": {
      const took = p.toolSince !== undefined ? fmtElapsed(nowMs - p.toolSince) : ""
      const what = p.lastActivity ?? p.lastTool ?? "a tool"
      return ` · running ${what}${took ? ` for ${took}` : ""}`
    }
    default:
      return p.lastTool ? ` · ${p.lastTool}` : ""
  }
}

function statusText(s: SubagentStatus, nowMs: number): string {
  switch (s.kind) {
    case "queued":
      return "queued"
    case "running": {
      const el = fmtElapsed(nowMs - Date.parse(s.startedAt))
      const p = s.progress
      const idleMs = p.lastEventAt !== undefined ? nowMs - p.lastEventAt : 0
      const idle =
        p.phase !== "tool" && idleMs >= 60_000 ? ` · no event for ${fmtElapsed(idleMs)}` : ""
      return `running ${el} · ${p.tools} tools · ${fmtSpend(p)}${streamFacts(p)}${nowDoing(p, nowMs)}${idle}`
    }
    case "done":
      return `done · ${fmtSpend(s.result)} · ${s.result.tools} tools${streamFacts(s.result)}`
    case "incomplete":
      return `incomplete · no deliverable (${s.reason}) · ${fmtSpend(s)} · ${s.tools} tools${streamFacts(s)}`
    case "failed":
      return `failed · ${s.error}`
    case "stopped":
      return `stopped${s.reason ? ` · ${s.reason}` : ""}`
    default: {
      throw new Error(`unhandled status kind: ${String(s satisfies never)}`)
    }
  }
}

/** One-line summary for a worker (for ListAgents / AgentStatus content). */
export function recordLine(r: SubagentRecord, nowMs: number): string {
  return `${r.id}  ${r.type.padEnd(10)}  ${statusText(r.status, nowMs)}`
}

/** The full fleet, as model-facing text. */
export function fleetText(records: readonly SubagentRecord[], nowMs: number): string {
  if (records.length === 0) {
    return "No sub-agents in this session. Use SpawnAgent to delegate a unit of work."
  }
  const s = fleetStats(records)
  const head = `Fleet: ${s.running} running · ${s.queued} queued · ${s.done} done · ${s.failed} failed · ${s.stopped} stopped · ${fmtSpend(s)} total`
  const rows = records.map((r) => recordLine(r, nowMs))
  const tail = s.done > 0 ? "\nPull a finished worker's deliverable with AgentResult <id>." : ""
  return `${head}\n\n${rows.join("\n")}${tail}`
}

/** One worker's detail (AgentStatus). */
export function statusDetail(r: SubagentRecord, nowMs: number): string {
  const resolved = r.status.kind === "running" ? r.status.progress.model : undefined
  const model = resolved && resolved !== r.model ? resolved : r.model || resolved || "default"
  const lines = [
    `${r.id} (${r.type}) · model ${model} · isolation ${r.isolation} · depth ${r.depth}`,
    `status: ${statusText(r.status, nowMs)}`,
    `session: ${r.sid}`,
    `task: ${r.task}`,
  ]
  if (r.status.kind === "done") lines.push(`result: ${r.status.result.short}`)
  return lines.join("\n")
}

/**
 * Model-facing text when fleet status is failed/stopped but a result sentinel
 * was found on disk. Keeps Dorothy-style handoffs recoverable even if status
 * lagged the file. Pure (no IO) so AgentResult stays thin.
 */
export function diskSalvageText(
  id: string,
  kind: "failed" | "stopped",
  why: string,
  short: string,
  artifacts?: readonly string[],
): string {
  const arts = artifacts && artifacts.length > 0 ? `\nartifacts: ${artifacts.join(", ")}` : ""
  return (
    `Sub-agent ${id} is marked ${kind} (${why}), but a result sentinel was found on disk. It is shown here so the work is not lost:\n\n` +
    `--- salvaged findings ---\n${short}${arts}`
  )
}

/** A finished worker's distilled deliverable (AgentResult). */
export function resultText(r: SubagentRecord): string {
  switch (r.status.kind) {
    case "done": {
      const res = r.status.result
      const arts =
        res.artifacts && res.artifacts.length > 0 ? `\nartifacts: ${res.artifacts.join(", ")}` : ""
      const note = res.distilled
        ? "\n\n(note: distilled from the worker's final message. It wrote no structured result sentinel, so this summary is best-effort and lists no artifacts)"
        : ""
      return `Sub-agent ${r.id} (${r.type}) result:\n\n${res.short}${arts}\n\n(${fmtSpend(res)} · ${res.tools} tool calls${streamFacts(res)})${note}`
    }
    case "incomplete": {
      const spent = r.status.tokens
        ? ` (spent ${fmtSpend(r.status)} · ${r.status.tools} tool calls)`
        : ""
      if (r.status.salvage) {
        // The contract was not met (a required file is missing/empty), but the
        // worker DID produce a synthesis. Surface it so the lead can act on the
        // work without mining the transcript — while making clear it's unverified
        // and the file the lead asked for does NOT exist.
        const arts =
          r.status.artifacts && r.status.artifacts.length > 0
            ? `\nclaimed artifacts (VERIFY — at least one is missing/empty): ${r.status.artifacts.join(", ")}`
            : ""
        return `Warning: sub-agent ${r.id} (${r.type}) finished INCOMPLETE. Deliverable contract not met: ${r.status.reason}${spent}. The required file does not exist, so this is not a clean success. But its findings were salvaged from the worker's summary below. Read them before you decide whether a re-run is needed. Often you can use this directly or write the file yourself from it.\n\n--- salvaged findings ---\n${r.status.salvage}${arts}`
      }
      return `Warning: sub-agent ${r.id} (${r.type}) finished WITHOUT a deliverable: ${r.status.reason}. This is not a success. The worker exited cleanly but produced no result summary${spent}. Treat the work as unverified: inspect its log/transcript, and re-spawn with a clearer task (and, if it was a file-producing job, set expectArtifacts) if you still need it.`
    }
    case "failed":
      return `Sub-agent ${r.id} failed: ${r.status.error}. No result was recorded on the fleet status. If you still need the work, re-spawn with a clearer task or a different model (or inspect the worker's session log/result sentinel on disk if one was written before the failure).`
    case "stopped":
      return `Sub-agent ${r.id} was stopped${r.status.reason ? `: ${r.status.reason}` : ""}. No result was recorded on the fleet status.`
    case "queued":
    case "running":
      return `Sub-agent ${r.id} is still ${r.status.kind}. No final result yet. Check AgentStatus ${r.id} or wait for the digest that arrives between turns when it finishes.`
    default: {
      throw new Error(`unhandled status kind: ${String(r.status satisfies never)}`)
    }
  }
}
