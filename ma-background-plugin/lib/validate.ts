/**
 * Input validation for the model-facing tools. Each tool's raw JSON input is
 * parsed into a typed request via a {@link Result}, so a malformed call is a
 * value the handler shapes into an error rather than a throw.
 *
 * Pure: no IO. The timeout STRING is preserved here, the handler resolves it to
 * ms with the live config (which knows the ceiling + infinite gate).
 *
 * @module lib/validate
 */

import { err, ok, type Result } from "./types.ts"

/** A validated `BackgroundRun` request. */
export interface RunRequest {
  readonly command: string
  readonly description?: string
  readonly cwd?: string
  /** Raw timeout the model wrote ("10m", 90, ...). Resolved later with config. */
  readonly timeout?: string | number
}

/** A validated `BackgroundLogs` request. */
export interface LogsRequest {
  readonly id: string
  readonly tail?: number
  readonly offset?: number
  readonly limit?: number
  readonly grep?: string
  readonly since?: number
  readonly raw: boolean
}

/** A validated `BackgroundStatus` request (id optional = all). */
export interface StatusRequest {
  readonly id?: string
}

/** A validated `BackgroundStop` request. */
export interface StopRequest {
  readonly id?: string
  readonly signal?: "SIGTERM" | "SIGKILL"
  readonly reason?: string
}

/** Compile a regex, returning a typed result instead of throwing. */
function compileRegex(source: string): Result<RegExp> {
  try {
    return ok(new RegExp(source))
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
}

function optString(v: unknown, field: string): Result<string | undefined> {
  if (v === undefined) return ok(undefined)
  if (typeof v !== "string") return err(`\`${field}\` must be a string`)
  const t = v.trim()
  return ok(t.length === 0 ? undefined : t)
}

function optPositiveInt(v: unknown, field: string): Result<number | undefined> {
  if (v === undefined) return ok(undefined)
  if (typeof v !== "number" || !Number.isFinite(v)) return err(`\`${field}\` must be a number`)
  if (v < 0) return err(`\`${field}\` must not be negative`)
  return ok(Math.floor(v))
}

/** Validate `BackgroundRun` input. */
export function parseRunRequest(raw: Record<string, unknown>): Result<RunRequest> {
  if (typeof raw.command !== "string") return err("`command` is required and must be a string")
  const command = raw.command.trim()
  if (command.length === 0) return err("`command` must not be empty")

  const desc = optString(raw.description, "description")
  if (!desc.ok) return desc
  const cwd = optString(raw.cwd, "cwd")
  if (!cwd.ok) return cwd

  let timeout: string | number | undefined
  if (raw.timeout !== undefined) {
    if (typeof raw.timeout !== "string" && typeof raw.timeout !== "number") {
      return err('`timeout` must be a string (e.g. "10m") or a number of seconds')
    }
    timeout = raw.timeout
  }

  return ok({
    command,
    ...(desc.value !== undefined ? { description: desc.value } : {}),
    ...(cwd.value !== undefined ? { cwd: cwd.value } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  })
}

/** Validate `BackgroundStatus` input. */
export function parseStatusRequest(raw: Record<string, unknown>): Result<StatusRequest> {
  const id = optString(raw.id, "id")
  if (!id.ok) return id
  return ok(id.value !== undefined ? { id: id.value } : {})
}

/** Validate `BackgroundLogs` input. */
export function parseLogsRequest(raw: Record<string, unknown>): Result<LogsRequest> {
  const id = optString(raw.id, "id")
  if (!id.ok) return id
  if (id.value === undefined) return err("`id` is required")

  const tail = optPositiveInt(raw.tail, "tail")
  if (!tail.ok) return tail
  const offset = optPositiveInt(raw.offset, "offset")
  if (!offset.ok) return offset
  const limit = optPositiveInt(raw.limit, "limit")
  if (!limit.ok) return limit
  const since = optPositiveInt(raw.since, "since")
  if (!since.ok) return since
  const grep = optString(raw.grep, "grep")
  if (!grep.ok) return grep
  if (grep.value !== undefined) {
    // Validate the regex eagerly so a bad pattern is a clean error.
    const compiled = compileRegex(grep.value)
    if (!compiled.ok) return err(`\`grep\` is not a valid regex: ${compiled.error}`)
  }

  let rawFlag = false
  if (raw.raw !== undefined) {
    if (typeof raw.raw !== "boolean") return err("`raw` must be a boolean")
    rawFlag = raw.raw
  }

  return ok({
    id: id.value,
    ...(tail.value !== undefined ? { tail: tail.value } : {}),
    ...(offset.value !== undefined ? { offset: offset.value } : {}),
    ...(limit.value !== undefined ? { limit: limit.value } : {}),
    ...(since.value !== undefined ? { since: since.value } : {}),
    ...(grep.value !== undefined ? { grep: grep.value } : {}),
    raw: rawFlag,
  })
}

/** Validate `BackgroundStop` input. */
export function parseStopRequest(raw: Record<string, unknown>): Result<StopRequest> {
  const id = optString(raw.id, "id")
  if (!id.ok) return id
  const reason = optString(raw.reason, "reason")
  if (!reason.ok) return reason

  let signal: "SIGTERM" | "SIGKILL" | undefined
  if (raw.signal !== undefined) {
    if (raw.signal !== "SIGTERM" && raw.signal !== "SIGKILL") {
      return err('`signal` must be "SIGTERM" or "SIGKILL"')
    }
    signal = raw.signal
  }

  return ok({
    ...(id.value !== undefined ? { id: id.value } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(reason.value !== undefined ? { reason: reason.value } : {}),
  })
}
