/**
 * Tool-call handler for `BackgroundStatus`.
 *
 * Reconciles first (so a job that finished since the last tick is up to date),
 * then returns a cheap glance: per job its state, elapsed time, exit code, a
 * short stripped tail of recent output, and the command. With an `id`, reports
 * that one job, without, the whole session's jobs.
 *
 * Deliberately cheap so the model can poll freely. The rich, parametrized read
 * is `BackgroundLogs`.
 *
 * @module handlers/bg_status
 */

import { loadBgConfig } from "../lib/config.ts"
import { readFileMaybe, realReconcileIO, serviceDepsFromCtx } from "../lib/handler-deps.ts"
import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { selectLog } from "../lib/log-read.ts"
import {
  configureSgr,
  dim,
  gray,
  jobBlock,
  jobHeaderContent,
  jobLines,
  statusWord,
} from "../lib/render.ts"
import { runReconcile } from "../lib/service.ts"
import { type JobRecord, jobStats } from "../lib/types.ts"
import { parseStatusRequest } from "../lib/validate.ts"

const STATUS_TAIL_LINES = 6
const STATUS_TAIL_BYTES = 2048

const handler = async (ctx: TUIContext): Promise<TUIResult> => {
  configureSgr(ctx.env.MINIMAL_AGENT_PALETTE)

  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "BackgroundStatus: wrong trigger type", is_error: true }
  }

  const parsed = parseStatusRequest(ctx.trigger.input)
  if (!parsed.ok) {
    return { kind: "tool_result", content: `BackgroundStatus: ${parsed.error}`, is_error: true }
  }

  const config = loadBgConfig(ctx.env as NodeJS.ProcessEnv)
  const deps = serviceDepsFromCtx(ctx, config)
  if (!deps) {
    return {
      kind: "tool_result",
      content: "BackgroundStatus: no session id available.",
      is_error: true,
    }
  }

  // Reconcile so the reported state is current.
  const { records } = runReconcile(deps, realReconcileIO())
  const nowMs = Date.now()

  if (parsed.value.id !== undefined) {
    const rec = records.find((r) => r.id === parsed.value.id)
    if (!rec) {
      return {
        kind: "tool_result",
        content: `BackgroundStatus: no job with handle "${parsed.value.id}" in this session.`,
        is_error: true,
      }
    }
    return {
      kind: "tool_result",
      content: oneJobContent(rec),
      displayHeader: jobHeaderContent(rec, nowMs),
      display: oneJobDisplay(rec, nowMs),
    }
  }

  if (records.length === 0) {
    return {
      kind: "tool_result",
      content: "No background jobs in this session.",
      display: jobLines([], nowMs),
    }
  }

  return {
    kind: "tool_result",
    content: allJobsContent(records),
    displayHeader: summaryHeader(records),
    display: jobLines(records, nowMs),
  }
}

/**
 * Transcript display for a single job: the rich block plus, when the log has
 * any output, a short dim tail preview (last few lines) so the user sees real
 * output inline without a separate BackgroundLogs call.
 */
function oneJobDisplay(rec: JobRecord, nowMs: number): string {
  const block = jobBlock(rec, nowMs)
  const tail = tailOf(rec)
  if (!tail) return block
  const previewLines = tail.split("\n").map((l) => dim(l))
  return `${block}\n${gray("─ recent output ─")}\n${previewLines.join("\n")}`
}

/** Model-facing content for a single job, including a short tail. */
function oneJobContent(rec: JobRecord): string {
  const head = `Job ${rec.id}: ${statusWord(rec.status)}. Command: \`${rec.command}\`.`
  const tail = tailOf(rec)
  return tail ? `${head}\nRecent output:\n${tail}` : `${head} (no output yet)`
}

/** Model-facing content for all jobs (compact, no tails). */
function allJobsContent(records: readonly JobRecord[]): string {
  const s = jobStats(records)
  const lines = records.map((r) => `  ${r.id}  ${statusWord(r.status)}  \`${clip(r.command, 60)}\``)
  return (
    `${records.length} background job(s): ${s.running} running, ${s.exited} exited, ` +
    `${s.timedout} timed out, ${s.stopped} stopped, ${s.orphaned} orphaned.\n${lines.join("\n")}\n` +
    `Use BackgroundLogs <id> to read a job's output.`
  )
}

/** Read a short, stripped tail of a job's log for the glance. */
function tailOf(rec: JobRecord): string | undefined {
  const content = readFileMaybe(rec.logPath)
  if (content === undefined || content.length === 0) return undefined
  const sel = selectLog(content, {
    tail: STATUS_TAIL_LINES,
    maxBytes: STATUS_TAIL_BYTES,
    raw: false,
  })
  return sel.text.length > 0 ? sel.text : undefined
}

function summaryHeader(records: readonly JobRecord[]): string {
  const s = jobStats(records)
  const parts = [`${s.running} running`, `${records.length} total`]
  if (s.succeeded > 0) parts.push(`${s.succeeded} done`)
  const failed = s.exited - s.succeeded + s.timedout
  if (failed > 0) parts.push(`${failed} failed`)
  return parts.join(" · ")
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

export default handler
