/**
 * Tool-call handler for `SpeakStatus`.
 *
 * Read-only. With an `id`, reports that one job's state. Without an `id`,
 * lists every speech job this session. Reads the same module-singleton
 * registry the `Speak` handler writes to, so it sees live state across calls.
 *
 * @module handlers/speak_status
 */

import { getRegistry, type SpeechJob, type SpeechRegistry } from "../lib/registry.ts"
import { dim, red, renderJobLine, renderJobList } from "../lib/render.ts"
import type { TUIContext, TUIResult } from "../lib/types.ts"

/** Default export: the tool handler the loader invokes. */
const handler = async (ctx: TUIContext): Promise<TUIResult> => {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "SpeakStatus: wrong trigger type", is_error: true }
  }
  const raw = ctx.trigger.input
  let id: string | undefined
  if (raw.id !== undefined) {
    if (typeof raw.id !== "string") {
      return { kind: "tool_result", content: "SpeakStatus: `id` must be a string", is_error: true }
    }
    const trimmed = raw.id.trim()
    if (trimmed.length > 0) id = trimmed
  }
  return runStatus(getRegistry(), id, Date.now())
}

/** Test-injectable core. Pure apart from reading the registry + clock. */
export function runStatus(
  registry: SpeechRegistry,
  id: string | undefined,
  now: number,
): TUIResult {
  if (id === undefined) {
    return statusAll(registry, now)
  }
  const job = registry.get(id)
  if (!job) {
    return {
      kind: "tool_result",
      content: `SpeakStatus: no speech job with handle "${id}" in this session.`,
      is_error: true,
      displayHeader: red("unknown job"),
      display: dim(`no job "${id}"`),
    }
  }
  return {
    kind: "tool_result",
    content: statusContent(job),
    displayHeader: job.id,
    display: renderJobLine(job, now),
  }
}

/** Status of all jobs (no id supplied). */
function statusAll(registry: SpeechRegistry, now: number): TUIResult {
  const jobs = registry.list()
  const active = jobs.filter((j) => j.state === "speaking")
  let content: string
  if (jobs.length === 0) {
    content = "No speech jobs this session. Nothing is playing."
  } else if (active.length === 0) {
    content = `No speech is playing. ${jobs.length} past job(s) this session: ${summary(jobs)}.`
  } else {
    content =
      `${active.length} job(s) speaking now (${active.map((j) => j.id).join(", ")}). ` +
      `${jobs.length} total this session: ${summary(jobs)}.`
  }
  return {
    kind: "tool_result",
    content,
    displayHeader: `${jobs.length} job(s)`,
    display: renderJobList(jobs, now),
  }
}

/** A compact `s1=done, s2=speaking` summary for the model-facing content. */
function summary(jobs: SpeechJob[]): string {
  return jobs.map((j) => `${j.id}=${j.state}`).join(", ")
}

/** Single-job model-facing content. */
export function statusContent(job: SpeechJob): string {
  switch (job.state) {
    case "speaking":
      return `Speech job ${job.id} is still speaking (${job.charCount} chars, pid ${job.pid || "?"}).`
    case "done":
      return `Speech job ${job.id} finished; the text was read aloud.`
    case "failed":
      return `Speech job ${job.id} failed: ${job.failureReason ?? "the text could not be spoken."}`
    case "stopped":
      return `Speech job ${job.id} was stopped before it finished.`
  }
}

export default handler
