/**
 * Tool-call handler for `BackgroundLogs`.
 *
 * The deliberate, parametrized read of a job's raw log: tail / line range /
 * grep / a `since` byte cursor for incremental streaming, ANSI stripped by
 * default. Output is bounded by config (`log.maxModelBytes`), the on-disk log
 * is never capped, so the full bytes always survive for a later read.
 *
 * @module handlers/bg_logs
 */

import { loadBgConfig } from "../lib/config.ts"
import { fileSize, readFileMaybe, storeFromCtx } from "../lib/handler-deps.ts"
import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { type LogIO, readLog } from "../lib/log-read.ts"
import { dim, statusWord } from "../lib/render.ts"
import { parseLogsRequest } from "../lib/validate.ts"

const handler = async (ctx: TUIContext): Promise<TUIResult> => {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "BackgroundLogs: wrong trigger type", is_error: true }
  }

  const parsed = parseLogsRequest(ctx.trigger.input)
  if (!parsed.ok) {
    return { kind: "tool_result", content: `BackgroundLogs: ${parsed.error}`, is_error: true }
  }
  const req = parsed.value

  const config = loadBgConfig(ctx.env as NodeJS.ProcessEnv)
  const store = storeFromCtx(ctx)
  if (!store) {
    return {
      kind: "tool_result",
      content: "BackgroundLogs: no session id available.",
      is_error: true,
    }
  }

  const rec = store.get(req.id)
  if (!rec) {
    return {
      kind: "tool_result",
      content: `BackgroundLogs: no job with handle "${req.id}" in this session.`,
      is_error: true,
    }
  }

  const io: LogIO = { readFile: readFileMaybe, size: fileSize }
  const result = readLog(
    rec.logPath,
    {
      maxBytes: config.log.maxModelBytes,
      raw: req.raw,
      ...(req.tail !== undefined ? { tail: req.tail } : {}),
      ...(req.offset !== undefined ? { offset: req.offset } : {}),
      ...(req.limit !== undefined ? { limit: req.limit } : {}),
      ...(req.grep !== undefined ? { grep: req.grep } : {}),
      ...(req.since !== undefined ? { since: req.since } : {}),
    },
    io,
  )

  if (!result.exists) {
    return {
      kind: "tool_result",
      content: `Job ${rec.id} (${statusWord(rec.status)}) has no log file yet.`,
      displayHeader: rec.id,
      display: dim("(no log yet)"),
    }
  }

  const notes: string[] = []
  if (result.filtered) notes.push(`grep "${req.grep}"`)
  if (result.clippedByBytes)
    notes.push(`clipped to ${config.log.maxModelBytes}B (read more with offset/since)`)
  const shown = `shown ${result.shownLines}/${result.totalLines} lines`
  const cursor = `byte cursor ${result.byteCursor} (pass as 'since' to stream new output)`
  const header = `Job ${rec.id} (${statusWord(rec.status)}) log: ${shown}${notes.length ? ` · ${notes.join(" · ")}` : ""}. ${cursor}.`

  const body = result.text.length > 0 ? result.text : "(no matching output)"
  return {
    kind: "tool_result",
    content: `${header}\n\n${body}`,
    displayHeader: `${rec.id} log`,
    display: dim(`${shown} · cursor ${result.byteCursor}`),
  }
}

export default handler
