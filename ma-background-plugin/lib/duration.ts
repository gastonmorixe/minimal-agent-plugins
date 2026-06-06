/**
 * Duration parsing for the model-facing `timeout` field.
 *
 * The model writes friendly strings ("90s", "10m", "2h", "1d") or a bare number
 * of seconds. This module turns that into milliseconds, with an
 * operator-gated "infinite" escape hatch. Pure: no IO, no clock.
 *
 * @module lib/duration
 */

import { err, ok, type Result } from "./types.ts"

/** One day in ms: the hard ceiling for a normal job. */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000

/** Sentinel meaning "no deadline" (operator-gated). */
export const INFINITE_MS = 0

/** Tokens the model may write to mean "no deadline". */
const INFINITE_TOKENS = new Set(["infinite", "inf", "none", "never", "0"])

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
}

/** Options for {@link parseDuration}. */
export interface ParseDurationOptions {
  /** Default ms when the input is absent/empty. */
  readonly defaultMs: number
  /** Hard ceiling in ms. A finite value over this is clamped down. */
  readonly maxMs: number
  /** Whether `infinite` / `0` is allowed. When false, infinite is rejected. */
  readonly allowInfinite: boolean
  /** Floor for a finite duration, in ms. Default 1000 (1s). */
  readonly minMs?: number
}

/** A parsed duration plus whether it was clamped down to the ceiling. */
export interface ParsedDuration {
  /** Resolved duration in ms. {@link INFINITE_MS} (0) means no deadline. */
  readonly ms: number
  /** True when a finite request exceeded `maxMs` and was clamped to it. */
  readonly clamped: boolean
  /** True when the result is the infinite sentinel. */
  readonly infinite: boolean
}

/**
 * Parse a raw `timeout` value into a {@link ParsedDuration}.
 *
 * Accepts:
 *   - `undefined` / `""` -> `defaultMs`
 *   - a number -> seconds (so the model can write `90`)
 *   - `"<n><unit>"` -> `ms|s|m|h|d` (e.g. `"10m"`, `"2h"`, `"1d"`, `"500ms"`)
 *   - `"<n>"` (string) -> seconds
 *   - `"infinite"` / `"inf"` / `"none"` / `"never"` / `"0"` -> infinite, IF allowed
 *
 * A finite duration is clamped into `[minMs, maxMs]`. Returns a {@link Result}
 * so an invalid string is a typed failure, never a throw.
 */
export function parseDuration(
  raw: string | number | undefined,
  opts: ParseDurationOptions,
): Result<ParsedDuration> {
  const minMs = opts.minMs ?? 1000

  if (raw === undefined) {
    return ok({ ms: opts.defaultMs, clamped: false, infinite: opts.defaultMs === INFINITE_MS })
  }

  // A numeric input is seconds.
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return err("timeout must be a finite number of seconds")
    if (raw === 0) return finiteOrInfinite(0, opts, minMs)
    if (raw < 0) return err("timeout must not be negative")
    return finiteOrInfinite(Math.round(raw * 1000), opts, minMs)
  }

  const s = raw.trim().toLowerCase()
  if (s.length === 0) {
    return ok({ ms: opts.defaultMs, clamped: false, infinite: opts.defaultMs === INFINITE_MS })
  }

  if (INFINITE_TOKENS.has(s)) {
    if (!opts.allowInfinite) {
      return err('an infinite timeout is not enabled; set a concrete duration like "30m" or "2h"')
    }
    return ok({ ms: INFINITE_MS, clamped: false, infinite: true })
  }

  // Match "<number><optional unit>". A bare number means seconds.
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/)
  if (!m) {
    return err(`could not parse timeout "${raw}"; use forms like "90s", "10m", "2h", "1d"`)
  }
  const value = Number.parseFloat(m[1])
  if (!Number.isFinite(value)) return err(`could not parse timeout "${raw}"`)
  const unit = m[2] === "" ? "s" : m[2]
  const unitMs = UNIT_MS[unit]
  if (unitMs === undefined) {
    return err(`unknown time unit "${unit}"; use ms, s, m, h, or d`)
  }
  return finiteOrInfinite(Math.round(value * unitMs), opts, minMs)
}

/** Clamp a finite ms duration into range and report clamping. Pure. */
function finiteOrInfinite(
  ms: number,
  opts: ParseDurationOptions,
  minMs: number,
): Result<ParsedDuration> {
  if (ms === 0) {
    // A literal 0 ms request is treated as infinite, gated the same way.
    if (!opts.allowInfinite) {
      return err('an infinite timeout is not enabled; set a concrete duration like "30m" or "2h"')
    }
    return ok({ ms: INFINITE_MS, clamped: false, infinite: true })
  }
  if (ms > opts.maxMs) {
    return ok({ ms: opts.maxMs, clamped: true, infinite: false })
  }
  if (ms < minMs) {
    return ok({ ms: minMs, clamped: false, infinite: false })
  }
  return ok({ ms, clamped: false, infinite: false })
}

/** Format an ms duration as a compact human string ("41s", "10m", "2h", "1d"). */
export function formatDuration(ms: number): string {
  if (ms === INFINITE_MS) return "∞"
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  return `${d}d`
}
