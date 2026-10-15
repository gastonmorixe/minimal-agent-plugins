// Credits for rules written after an upstream idea. One row per (tool, ruleId).
// Every rule with `inspiredBy` must have a row here (completeness test).

export type CreditRow = {
  readonly tool: string
  readonly ruleId: string
  readonly url: string
  readonly license: string
  /** What we took: idea, keywords, test shapes. Never verbatim code. */
  readonly took: string
}

export const CREDITS: readonly CreditRow[] = []

/** True when a credits row exists for (tool, ruleId). */
export function hasCredit(tool: string, ruleId: string): boolean {
  return CREDITS.some((c) => c.tool === tool && c.ruleId === ruleId)
}
