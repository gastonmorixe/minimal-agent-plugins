// The registry index. Hand-listed, sorted by id. The only import point for rules.
// Add a rule: create src/rules/<family>/<id>.ts with one default export, import it
// here, and insert it in the family array in id order. The completeness test checks
// both directions.
import type { CmdRule, PathRule, RedactRule } from "./types.ts"

export const REDACT_RULES: readonly RedactRule[] = []

export const PATH_RULES: readonly PathRule[] = []

export const CMD_RULES: readonly CmdRule[] = []

/** Old id to new id. A hit gives a one-time notice. No alias equals a live id. */
export const ALIASES: Readonly<Record<string, string>> = {}
