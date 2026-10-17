// Compile and scan one redact rule (split from selftest.ts). Sync, pure, never throws.
import { shannon, VALIDATORS } from "../engine/validators.ts"

import { ALLOWLISTS } from "./allowlists.ts"
import type { RedactRule } from "./types.ts"

/** A redact rule with its compiled regex and allowlists. */
export type CompiledRedactRule = {
  readonly rule: RedactRule
  /** Null for known-value only rules (no pattern). Flags include "g", plus "d" for a capture group. */
  readonly re: RegExp | null
  /** Tested against the whole capture. */
  readonly allowPatterns: readonly RegExp[]
  /** Lowercase. The whole capture must equal one. */
  readonly allowWords: readonly string[]
  /** Lowercase. A capture that contains one is allowed (stopwords opt-in only). */
  readonly allowSubstrings: readonly string[]
}

/** One raw rule hit (no kind or layer yet). */
export type RuleHit = { start: number; end: number; value: string }

export type ScanRuleOptions = {
  /** Skip min_len, validator, entropy, and allowlists. */
  raw?: boolean
  /** Stop after this many hits. Default 10000. */
  limit?: number
}

/** Max distance in chars between a keyword hit and the span (windowed mode over 4 MB). */
export const KEYWORD_WINDOW = 300

/** Compile a redact rule. Returns the compiled form or an error string. Never throws. */
export function compileRedactRule(rule: RedactRule): CompiledRedactRule | string {
  try {
    const flags = rule.flags ?? ""
    if (flags !== "" && flags !== "i") return `bad flags "${String(flags)}"`
    if (rule.validator !== undefined && !Object.hasOwn(VALIDATORS, rule.validator))
      return `unknown validator "${rule.validator}"`
    // fix3 MINOR 5, fix4 MINOR 1: here so skipSelfTest cannot bypass it. Substring
    // stopwords are for the generic kv rule, never a provider rule.
    if (rule.allowStopwords === true && rule.render?.publicPrefix !== undefined)
      return "allowStopwords is not allowed on a provider rule (publicPrefix set)"
    const group = rule.group ?? 0
    let re: RegExp | null = null
    if (rule.pattern !== undefined)
      re = new RegExp(rule.pattern, `${flags}g${group > 0 ? "d" : ""}`)
    const allowPatterns: RegExp[] = []
    const allowWords: string[] = []
    const allowSubstrings: string[] = []
    for (const id of rule.allow ?? []) {
      const list = ALLOWLISTS[id]
      if (!list) return `unknown allowlist "${id}"`
      if (list.substring && rule.allowStopwords !== true)
        return `allowlist "${id}" needs allowStopwords: true`
      for (const p of list.patterns) allowPatterns.push(new RegExp(p, "i"))
      for (const w of list.words) (list.substring ? allowSubstrings : allowWords).push(w)
    }
    return { rule, re, allowPatterns, allowWords, allowSubstrings }
  } catch (e) {
    return `compile: ${e instanceof Error ? e.message : String(e)}`
  }
}

function passesFilters(c: CompiledRedactRule, value: string): boolean {
  const r = c.rule
  if (r.defaults.min_len !== undefined && value.length < r.defaults.min_len) return false
  if (r.validator !== undefined && !VALIDATORS[r.validator](value)) return false
  if (r.entropy !== undefined && shannon(value) < r.entropy.min) return false
  if (c.allowPatterns.some((p) => p.test(value))) return false
  const lower = value.toLowerCase()
  if (c.allowWords.includes(lower)) return false
  if (c.allowSubstrings.some((w) => lower.includes(w))) return false
  return true
}

/** Run one compiled rule over text (exec loop). No prefilter, no merge. */
export function scanRule(
  c: CompiledRedactRule,
  text: string,
  opts: ScanRuleOptions = {},
): RuleHit[] {
  const hits: RuleHit[] = []
  const re = c.re
  if (re === null) return hits
  const group = c.rule.group ?? 0
  const limit = opts.limit ?? 10000
  re.lastIndex = 0
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length === 0) re.lastIndex++
    const value = m[group]
    if (value === undefined || value.length === 0) continue
    let start = m.index
    if (group > 0) {
      const span = m.indices?.[group]
      if (span === undefined) continue
      start = span[0]
    }
    if (!opts.raw && !passesFilters(c, value)) continue
    hits.push({ start, end: start + value.length, value })
    if (hits.length >= limit) break
  }
  re.lastIndex = 0
  return hits
}
