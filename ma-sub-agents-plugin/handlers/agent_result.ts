/**
 * `AgentResult` — pull a finished worker's distilled deliverable. This is the
 * ONLY tool that carries real worker content into the lead's context, and it
 * is bounded (the worker's result sentinel, not its transcript). When a worker
 * exited without a sentinel, fall back to a short tail of its stdout log so the
 * lead still gets something.
 *
 * @module sub-agents/handlers/agent_result
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { join } from "node:path"

import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { diskSalvageText, resultText } from "../lib/content.ts"
import { sessionsDirFromCtx, storeFromCtx } from "../lib/handler-deps.ts"
import type { ToolAvailability, TUIContext, TUIResult } from "../lib/host-types.ts"
import { renderResultDisplay } from "../lib/render.ts"
import { isContractedFilePresent } from "../lib/report.ts"
import { ENV_RESULT_PATH, parseResultDigest } from "../lib/spawn.ts"
import { isTerminal, type SubagentRecord } from "../lib/types.ts"
import { parseIdArg } from "../lib/validate.ts"

/** Lead-only tool: hide from leaf sub-agents. */
export const available: ToolAvailability = (ctx) => !ctx.env[ENV_RESULT_PATH]?.trim()

const TAIL_LOG_MAX_BYTES = 64 * 1024

/** Strip ANSI and return the last `n` non-empty lines of a worker log (capped to last 64 KiB). */
function tailLog(path: string, n: number): string | null {
  if (!existsSync(path)) return null
  try {
    const size = statSync(path).size
    if (size === 0) return null
    const length = Math.min(size, TAIL_LOG_MAX_BYTES)
    const offset = size - length
    const fd = openSync(path, "r")
    let raw: string
    try {
      const buf = Buffer.alloc(length)
      const bytesRead = readSync(fd, buf, 0, length, offset)
      if (bytesRead <= 0) return null
      raw = buf.subarray(0, bytesRead).toString("utf-8")
    } finally {
      closeSync(fd)
    }
    const text = stripAnsi(raw)
    const lines = text
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
    if (lines.length === 0) return null
    return lines.slice(-n).join("\n")
  } catch {
    return null
  }
}

function readDiskSentinel(sessionsDir: string, sid: string) {
  const sentinelPath = join(sessionsDir, `${sid}.result.json`)
  if (!existsSync(sentinelPath)) return undefined
  try {
    return parseResultDigest(JSON.parse(readFileSync(sentinelPath, "utf-8")))
  } catch {
    return undefined
  }
}

function missingContractPaths(rec: SubagentRecord): string[] {
  if (!rec.expectArtifacts || rec.expectArtifacts.length === 0) return []
  return rec.expectArtifacts.filter((p) => !isContractedFilePresent(p))
}

/**
 * Tool handler for `AgentResult`: pulls a finished worker's distilled
 * deliverable (summary + artifacts, or salvaged findings) into the lead's
 * context.
 */
export default async function agentResult(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "AgentResult: unexpected trigger", is_error: true }
  }
  const id = parseIdArg(ctx.trigger.input)
  if (!id)
    return { kind: "tool_result", content: "AgentResult: an `id` is required.", is_error: true }

  const store = storeFromCtx(ctx)
  if (!store)
    return {
      kind: "tool_result",
      content: "AgentResult: no session id available.",
      is_error: true,
    }
  const rec = store.get(id)
  if (!rec)
    return {
      kind: "tool_result",
      content: `AgentResult: unknown sub-agent "${id}".`,
      is_error: true,
    }

  let displayRec = rec
  let content = resultText(rec)
  const sessionsDir = sessionsDirFromCtx(ctx)
  // If fleet status still lags at `running` (1s heartbeat lag) but the worker
  // already wrote its sentinel on disk, surface the result immediately instead
  // of making the lead wait another turn.
  if (rec.status.kind === "running") {
    const digest = readDiskSentinel(sessionsDir, rec.sid)
    if (digest?.short.trim()) {
      const missing = missingContractPaths(rec)
      const nowIso = new Date().toISOString()
      if (digest.incomplete || missing.length > 0) {
        const reason =
          missing.length > 0
            ? `missing required artifacts: ${missing.join(", ")}`
            : "worker reported it could not finish"
        displayRec = {
          ...rec,
          status: {
            kind: "incomplete",
            endedAt: nowIso,
            reason,
            tokens: digest.tokens || rec.status.progress.tokens,
            tools: digest.tools || rec.status.progress.tools,
            salvage: digest.short,
            ...(digest.artifacts ? { artifacts: digest.artifacts } : {}),
          },
        }
      } else {
        displayRec = {
          ...rec,
          status: {
            kind: "done",
            endedAt: nowIso,
            result: digest,
          },
        }
      }
      content = resultText(displayRec)
    }
  }
  // Defense in depth (Dorothy A1/A2): if fleet status is failed/stopped but the
  // worker already wrote a result sentinel, surface that handoff instead of the
  // hard "No result" lie. Also check expectArtifacts so missing files are clear.
  if (rec.status.kind === "failed" || rec.status.kind === "stopped") {
    const digest = readDiskSentinel(sessionsDir, rec.sid)
    if (digest?.short.trim()) {
      const why = rec.status.kind === "failed" ? rec.status.error : (rec.status.reason ?? "stopped")
      const missing = missingContractPaths(rec)
      const missingNote =
        missing.length > 0
          ? `\n\nWarning: required artifacts missing or empty: ${missing.join(", ")}`
          : ""
      content =
        diskSalvageText(rec.id, rec.status.kind, why, digest.short, digest.artifacts) + missingNote
    }
  }
  // Mark terminal records collected so SubagentsAttachment can collapse to null
  // once all finished results have been pulled by the lead.
  if (isTerminal(rec.status) && rec.uncollected) {
    const { uncollected: _drop, ...collected } = rec
    store.upsert(collected)
  }
  // Surface the worker's log tail whenever the lead would otherwise be blind:
  //   - a `done` worker whose summary is the legacy "no summary captured"
  //     placeholder, OR
  //   - any `failed`/`incomplete` worker (FIX B). A crashed or silent worker's
  //     only forensic trail is its stdout/stderr; without this the lead has to
  //     know to go read `<sid>.log` by hand (exactly the trap that hid the boot
  //     crash). The tail is bounded and stripped of ANSI.
  const blindDone =
    displayRec.status.kind === "done" &&
    displayRec.status.result.short.includes("no summary captured")
  const blindTerminal =
    displayRec.status.kind === "failed" || displayRec.status.kind === "incomplete"
  if (blindDone || blindTerminal) {
    const tail = tailLog(`${sessionsDir}/${rec.sid}.log`, 20)
    if (tail) content += `\n\nLast output (log tail of the sub-agent's stdout/stderr):\n${tail}`
  }
  const disp = renderResultDisplay(displayRec, true)
  return {
    kind: "tool_result",
    content,
    displayHeader: disp.header,
    display: disp.body,
    displayFooter: disp.footer,
  }
}
