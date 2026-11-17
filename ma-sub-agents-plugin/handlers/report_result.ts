/**
 * `ReportResult` — the worker's structured completion hand-back. A worker calls
 * this as its FINAL action; THIS handler (running inside the worker process)
 * writes the result sentinel deterministically. The model supplies findings; it
 * never touches a path or hand-rolls JSON, so the brittle part of the protocol
 * is owned by code, not by the model remembering an exact format.
 *
 * Env-gated: the worker carries `MINIMAL_AGENT_SUBAGENT_RESULT_PATH` (stamped by
 * the spawn plan). When that is absent — a LEAD called the tool — there is no
 * sentinel to write, so we return an explanation instead of doing anything.
 *
 * The write is atomic (temp file + rename) so the supervisor's probe, which may
 * read the path on any tick, never sees a half-written sentinel.
 *
 * @module sub-agents/handlers/report_result
 */

import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import type { ToolAvailability, TUIContext, TUIResult } from "../lib/host-types.ts"
import {
  buildDigest,
  checkDeliverables,
  type Deliverable,
  isContractedFilePresent,
  parseContract,
  parseReportRequest,
  serializeDigest,
} from "../lib/report.ts"
import { ENV_EXPECT_ARTIFACTS, ENV_RESULT_PATH } from "../lib/spawn.ts"

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Sibling temp path in the same directory, so the rename stays on one filesystem. */
function tmpPathFor(path: string, i = 0): string {
  return `${path}.tmp-${process.pid}-${i}`
}

/** Write text to a temp file (mkdir -p first). On a throw, remove the temp file. */
function writeTemp(tmp: string, text: string): void {
  try {
    mkdirSync(dirname(tmp), { recursive: true })
    writeFileSync(tmp, text, "utf-8")
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** Atomic write: sibling temp file, then rename over the target. No temp file stays on a throw. */
function writeAtomic(path: string, text: string): void {
  const tmp = tmpPathFor(path)
  writeTemp(tmp, text)
  try {
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** True when the path exists as a symbolic link (lstat does not follow it). */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Write all deliverables, all or nothing where the OS allows it. Phase 1 writes
 * every temp file. If one fails, all temps are removed and no target changes.
 * Phase 2 renames each temp over its target. A rename failure removes the
 * remaining temps, and the error lists the paths already renamed.
 * Returns an error text, or undefined on success.
 */
function writeAll(files: readonly Deliverable[]): string | undefined {
  const temps = files.map((f, i) => tmpPathFor(f.path, i))
  const cleanup = (from: number): void => {
    for (const t of temps.slice(from)) rmSync(t, { force: true })
  }
  for (const [i, f] of files.entries()) {
    try {
      writeTemp(temps[i] as string, f.content)
    } catch (e) {
      cleanup(0)
      return `SubAgentsReportResult: failed to write ${f.path}: ${errText(e)}. No file was written and no result was recorded. Fix the cause and call SubAgentsReportResult again.`
    }
  }
  const renamed: string[] = []
  for (const [i, f] of files.entries()) {
    try {
      renameSync(temps[i] as string, f.path)
      renamed.push(f.path)
    } catch (e) {
      cleanup(i)
      const done =
        renamed.length > 0
          ? ` These files were already written: ${renamed.join(", ")}.`
          : " No file was written."
      return `SubAgentsReportResult: failed to write ${f.path}: ${errText(e)}.${done} No result was recorded. Fix the cause and call SubAgentsReportResult again.`
    }
  }
  return undefined
}

function fail(content: string): TUIResult {
  return { kind: "tool_result", content, is_error: true }
}

/**
 * Availability gate: `ReportResult` is the SUB-AGENT completion tool, so it is
 * advertised ONLY inside a worker process. A worker carries the result-sentinel
 * path in its env (the spawn plan stamps `MINIMAL_AGENT_SUBAGENT_RESULT_PATH`);
 * the lead does not. Returning `false` for the lead hides the tool from its tool
 * list entirely, so the lead never sees it, never wastes tokens on it, and can't
 * call it by mistake. The handler keeps its own env check too (defense in depth
 * for a resumed/forced call). See {@link ToolAvailability}.
 */
export const available: ToolAvailability = (ctx) => Boolean(ctx.env[ENV_RESULT_PATH]?.trim())

/**
 * Tool handler for `ReportResult`: records a sub-agent worker's final
 * summary/artifacts at the result path the supervisor injected via env, so
 * the lead can read it back with `AgentResult`.
 */
export default async function reportResult(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return {
      kind: "tool_result",
      content: "SubAgentsReportResult: unexpected trigger",
      is_error: true,
    }
  }

  const parsed = parseReportRequest(ctx.trigger.input)
  if (!parsed.ok) return { kind: "tool_result", content: parsed.error, is_error: true }

  const resultPath = ctx.env[ENV_RESULT_PATH]?.trim()
  if (!resultPath) {
    // A lead (or a non-worker context) called ReportResult. There is no sentinel
    // to write. Tell the caller plainly rather than failing silently.
    return {
      kind: "tool_result",
      content:
        "SubAgentsReportResult is the SUB-AGENT completion tool: it records the result of a sub-agent for its lead. " +
        "This session is not a sub-agent (no result path in the environment), so there is nothing to report. " +
        "If you are the lead, reply normally. To read the result of a finished sub-agent, use SubAgentsAgentResult.",
      is_error: true,
    }
  }

  // The lead's `expectArtifacts` contract, stamped by the spawn. A read-only
  // worker has no Write tool, so it hands the contracted files to us in
  // `deliverables` and we write them. Paths outside the contract are refused.
  const contract = parseContract(ctx.env[ENV_EXPECT_ARTIFACTS])
  const req = parsed.value
  const written: string[] = []
  if (req.deliverables && req.deliverables.length > 0) {
    const checked = checkDeliverables(req.deliverables, contract)
    if (!checked.ok) return fail(checked.error)
    const links = checked.value.filter((d) => isSymlink(d.path)).map((d) => d.path)
    if (links.length > 0) {
      return fail(
        `SubAgentsReportResult does not write through a symlink. These required paths are symlinks: ${links.join(", ")}. ` +
          "Nothing was written. Ask the lead for a path that is not a symlink, or set incomplete:true and put the content in summary.",
      )
    }
    const failure = writeAll(checked.value)
    if (failure) return fail(failure)
    for (const d of checked.value) written.push(d.path)
  }

  // Contract gate BEFORE the sentinel: a missing required file is an error the
  // worker can fix in the same run. With `incomplete: true` we record as usual.
  const missing = contract.filter((p) => !isContractedFilePresent(p))
  if (missing.length > 0 && !req.incomplete) {
    return fail(
      `The lead requires these files, and they are missing or empty: ${missing.join(", ")}. ` +
        "No result was recorded. Call SubAgentsReportResult again and pass each file in `deliverables` " +
        'as { "path": "<absolute path>", "content": "<full file text>" }. ' +
        "This works in every mode, also read-only. If you cannot make a file, set incomplete:true and give the reason in summary.",
    )
  }

  const artifacts = [...(req.artifacts ?? [])]
  for (const p of written) if (!artifacts.includes(p)) artifacts.push(p)
  const digest = buildDigest({ ...req, ...(artifacts.length > 0 ? { artifacts } : {}) })
  const json = serializeDigest(digest)

  try {
    // Atomic publish so the supervisor never reads a partial sentinel.
    writeAtomic(resultPath, json)
  } catch (e) {
    return {
      kind: "tool_result",
      content: `SubAgentsReportResult: failed to write the result sentinel to ${resultPath}: ${errText(e)}. As a fallback, write that JSON to the path yourself.`,
      is_error: true,
    }
  }

  const writtenNote = written.length > 0 ? ` Wrote ${written.length} required file(s).` : ""
  const artifactNote = artifacts.length > 0 ? ` Recorded ${artifacts.length} artifact path(s).` : ""
  const stateNote = req.incomplete
    ? " Flagged INCOMPLETE: the lead will treat the work as unverified."
    : ""
  return {
    kind: "tool_result",
    content:
      `Result recorded. Your deliverable has been handed back to the lead.${writtenNote}${artifactNote}${stateNote} ` +
      "You can stop now. Nothing else is required.",
  }
}
