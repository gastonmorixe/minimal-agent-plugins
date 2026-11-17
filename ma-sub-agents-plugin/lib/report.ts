/**
 * Pure core for the `ReportResult` completion tool — the worker's structured
 * hand-back. A worker calls `ReportResult({summary, artifacts?, incomplete?})`
 * as its final action; the HANDLER (in the worker process) writes the sentinel
 * file deterministically. This module is the pure half: validate the model's
 * input and build the exact `ResultDigest` bytes to persist. No IO, no throw.
 *
 * Why a tool and not "ask the model to write a file": we cannot force a model
 * to emit any particular text, but we CAN make the one required final action a
 * single structured tool call and do the filesystem write ourselves. That moves
 * the brittle part (exact path, valid JSON) off the model and onto our code.
 * The model only supplies findings. A worker on a provider with no tool calling
 * still has the documented manual-sentinel fallback; distillation of the final
 * message is the floor below that. See `prompts/result-protocol.tmpl.md`.
 *
 * @module sub-agents/lib/report
 */

import { statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

import { err, ok, type Result, type ResultDigest } from "./types.ts"

/** The validated shape of a `ReportResult` tool input. */
export interface ReportRequest {
  /** The worker's findings: a dense, self-contained synthesis the lead reads. */
  readonly summary: string
  /** Absolute paths of files the worker created or changed. */
  readonly artifacts?: readonly string[]
  /** The worker is reporting it could NOT finish (lead should treat as unverified). */
  readonly incomplete?: boolean
  /** Optional self-reported counts (advisory; the supervisor's live progress is authoritative). */
  readonly tokens?: number
  readonly tools?: number
  /**
   * Files the handler writes for the worker. This is how a read-only worker
   * (mode `ask`, no Write tool) delivers its contracted `expectArtifacts`.
   */
  readonly deliverables?: readonly Deliverable[]
}

/** One file a worker hands to `ReportResult` to write. */
export interface Deliverable {
  /** Absolute path. Must be in the worker's `expectArtifacts` contract. */
  readonly path: string
  /** Full file text. Never empty. */
  readonly content: string
}

/** Cap on the total UTF-8 bytes of all deliverables in one call. */
export const MAX_DELIVERABLE_BYTES = 2 * 1024 * 1024

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
}

function nonNegInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined
}

function strArray(v: unknown, max = 32): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim())
  return out.length > 0 ? out.slice(0, max) : undefined
}

/**
 * Validate the optional `deliverables` input. Absent means no deliverables.
 * Only `path` names the file, the same as the tool schema. Rejects a non-array, an entry
 * with no path or empty content, and a total size over the cap.
 */
export function parseDeliverables(v: unknown): Result<Deliverable[] | undefined> {
  if (v === undefined || v === null) return ok(undefined)
  if (!Array.isArray(v)) {
    return err("`deliverables` must be an array of { path, content } objects.")
  }
  const out: Deliverable[] = []
  let bytes = 0
  for (const [i, raw] of v.entries()) {
    if (!raw || typeof raw !== "object") {
      return err(`\`deliverables[${i}]\` must be an object { path, content }.`)
    }
    const o = raw as Record<string, unknown>
    const path = str(o.path)
    if (!path) return err(`\`deliverables[${i}].path\` is required: the absolute path of the file.`)
    if (typeof o.content !== "string" || o.content.trim().length === 0) {
      return err(`\`deliverables[${i}].content\` is empty. Give the full file text for ${path}.`)
    }
    bytes += Buffer.byteLength(o.content, "utf-8")
    out.push({ path, content: o.content })
  }
  if (bytes > MAX_DELIVERABLE_BYTES) {
    return err(
      `\`deliverables\` total ${bytes} bytes, over the ${MAX_DELIVERABLE_BYTES} byte limit. ` +
        "Make the files shorter, or set incomplete:true and explain in the summary.",
    )
  }
  return ok(out.length > 0 ? out : undefined)
}

/**
 * Validate a raw `ReportResult` tool input into a {@link ReportRequest}. The
 * only hard requirement is a non-empty `summary` (the whole point of the call);
 * everything else is optional. Returns a {@link Result} so a malformed call
 * becomes a teaching `is_error` tool result rather than a thrown exception.
 */
export function parseReportRequest(input: Record<string, unknown>): Result<ReportRequest> {
  // Accept a few natural aliases the model might reach for, so a near-miss call
  // still succeeds instead of bouncing on a key name.
  const summary = str(input.summary) ?? str(input.short) ?? str(input.result) ?? str(input.findings)
  if (!summary) {
    return err(
      "`summary` is required: a dense, self-contained paragraph or two with your actual findings (not a pointer to them).",
    )
  }
  const artifacts = strArray(input.artifacts)
  const deliverables = parseDeliverables(input.deliverables)
  if (!deliverables.ok) return deliverables
  const incomplete = input.incomplete === true
  const tokens = nonNegInt(input.tokens)
  const tools = nonNegInt(input.tools)
  return ok({
    summary,
    ...(artifacts ? { artifacts } : {}),
    ...(incomplete ? { incomplete } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(deliverables.value ? { deliverables: deliverables.value } : {}),
  })
}

/**
 * Build the {@link ResultDigest} to persist as the sentinel. When the worker
 * flagged `incomplete`, we set the structured `incomplete` flag (which the
 * supervisor reducer branches on, routing the worker to an `incomplete` status
 * instead of `done`) AND prefix the summary with a human-readable `INCOMPLETE:`
 * marker so a hand-written fallback sentinel and the rendered text read the
 * same. Counts default to 0 (the supervisor's live progress is authoritative
 * for the widget).
 */
export function buildDigest(req: ReportRequest): ResultDigest {
  const short = req.incomplete ? `INCOMPLETE: ${req.summary}` : req.summary
  return {
    short,
    tokens: req.tokens ?? 0,
    tools: req.tools ?? 0,
    ...(req.artifacts && req.artifacts.length > 0 ? { artifacts: req.artifacts } : {}),
    ...(req.incomplete ? { incomplete: true } : {}),
  }
}

/**
 * Read the `expectArtifacts` contract from its env value (a JSON array of
 * absolute paths). Absent, malformed, or empty gives `[]` (no contract).
 * Entries are resolved and deduped.
 */
export function parseContract(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) return []
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== "string" || !isAbsolute(x.trim())) continue
    const p = resolve(x.trim())
    if (!out.includes(p)) out.push(p)
  }
  return out
}

/**
 * Check each deliverable against the contract. Returns the deliverables with
 * resolved paths, or a teaching error that lists the allowed paths.
 */
export function checkDeliverables(
  deliverables: readonly Deliverable[],
  contract: readonly string[],
): Result<Deliverable[]> {
  if (contract.length === 0) {
    return err(
      "`deliverables` is only for files the lead required (`expectArtifacts`), and this worker has no required files. " +
        "Remove `deliverables` and call SubAgentsReportResult again. Put your findings in `summary`. " +
        "If your task names required files, the lead may run an older sub-agents plugin; set incomplete:true and put the content in summary.",
    )
  }
  const out: Deliverable[] = []
  for (const d of deliverables) {
    if (d.path.length > 1 && d.path.endsWith("/")) {
      return err(
        `"${d.path}" ends with a trailing slash, so it names a directory, not a file. ` +
          `Allowed paths: ${contract.join(", ")}. Nothing was written. Remove the slash and call SubAgentsReportResult again.`,
      )
    }
    const p = isAbsolute(d.path) ? resolve(d.path) : undefined
    if (!p || !contract.includes(p)) {
      return err(
        `SubAgentsReportResult can write only the required files. "${d.path}" is not one of them. ` +
          `Allowed paths: ${contract.join(", ")}. Nothing was written. Fix the path and call SubAgentsReportResult again.`,
      )
    }
    if (out.some((o) => o.path === p)) {
      return err(
        `\`deliverables\` names ${p} more than once. Give each required file one time, with its full text. ` +
          "Nothing was written. Call SubAgentsReportResult again.",
      )
    }
    out.push({ path: p, content: d.content })
  }
  return ok(out)
}

/**
 * True when a contracted file is present: a regular file with at least one
 * byte. A directory, an empty file, or an absent path counts as missing. The
 * `ReportResult` handler and the supervisor probe both use this check.
 */
export function isContractedFilePresent(path: string): boolean {
  try {
    const st = statSync(path)
    return st.isFile() && st.size > 0
  } catch {
    return false
  }
}

/** Serialize a digest to the exact one-line JSON the probe's `readResult` parses. */
export function serializeDigest(digest: ResultDigest): string {
  return JSON.stringify(digest)
}
