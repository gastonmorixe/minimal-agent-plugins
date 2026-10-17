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

const GL = "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml"
const BL = "https://github.com/betterleaks/betterleaks/blob/main/config/betterleaks.toml"

function gl(ruleId: string, took: string): CreditRow {
  return { tool: "gitleaks", ruleId, url: GL, license: "MIT", took }
}

export const CREDITS: readonly CreditRow[] = [
  gl("anthropic-admin-api-key", "prefix, 93-char body and AA suffix shape, keyword"),
  gl("anthropic-api-key", "prefix, 93-char body and AA suffix shape, keyword"),
  gl("aws-access-token", "type prefix list and base32 body length, keywords"),
  gl("curl-auth-header", "header names and auth schemes to cover"),
  gl("gcp-api-key", "AIza prefix and 35-char body length"),
  gl("generic-api-key", "secret key words and the assignment operator list"),
  gl("github-fine-grained-pat", "github_pat_ prefix and body length"),
  gl("github-pat", "gh*_ prefixes and 36-char body length"),
  gl("gitlab-pat", "glpat- prefix and minimum body length"),
  gl("huggingface-access-token", "hf_ prefix and body length"),
  gl("jwt", "three-part eyJ shape idea and the eyj keyword"),
  gl("openai-api-key", "T3BlbkFJ marker idea, prefixes, and body lengths"),
  gl("private-key", "BEGIN ... PRIVATE KEY block idea"),
  gl("slack-bot-token", "xox* and xapp prefixes and segment shapes (also user and app rules)"),
  gl("stripe-access-token", "sk_ and rk_ prefixes with live, test, prod"),
  {
    tool: "betterleaks",
    ruleId: "xai-api-key",
    url: BL,
    license: "MIT",
    took: "xai- prefix, body length range, end-of-token lookahead form",
  },
]

/** True when a credits row exists for (tool, ruleId). */
export function hasCredit(tool: string, ruleId: string): boolean {
  return CREDITS.some((c) => c.tool === tool && c.ruleId === ruleId)
}
