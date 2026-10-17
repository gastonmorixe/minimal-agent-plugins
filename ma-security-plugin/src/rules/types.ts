// Rule types for the security rule registry (SPEC-v3 "Rule registry (design J)").
// Plain data fields (id, family, severity, explain, defaults, decision) are readable
// without running code. Only the engine calls CmdRule.match.

/** Rule status. "ask" acts as "warn" until core item 7 lands. */
export type Status = "off" | "warn" | "on" | "ask"

/** Redaction level. */
export type Level = "off" | "low" | "mid" | "high" | "xhigh"

export type Severity = "critical" | "high" | "medium" | "low"

export type Family = "secret" | "pii" | "path" | "cmd"

export type GenCharset = "alnum" | "alnum-_" | "hex" | "b64url" | "upper-digit"

/**
 * Seeded shape descriptor. gen(Gen) makes the value at test time, so no literal
 * secret-shaped value sits in the repo. `len` is the length of the random body only
 * (prefix and suffix are added around it).
 */
export type Gen = {
  prefix?: string
  len: number
  charset: GenCharset
  suffix?: string
  seed: number
}

/**
 * Example text. A plain string holds no secret-shaped value. `{text, secret}` replaces
 * `{{S}}` in `text` with gen(secret). In `match` the generated value is the expected
 * span. In `not_match` it is a near miss and the rule must give zero spans.
 */
export type Example = string | { text: string; secret: Gen }

/** Credit only. Every pattern is written by us. The row lives in src/rules/credits.ts. */
export type InspiredBy = { tool: string; ruleId: string; url: string }

/** Cheap gate in front of the regex. "keyword" needs keywords. All others need a reason in notes. */
export type Gate = "keyword" | "digit-run" | "quoted-string" | "always"

export type ValidatorName = "luhn" | "jwt-shape"

export type AllowlistId = "placeholder" | "gitleaks-global" | "stopwords"

export type RedactRule = {
  /** "secret.anthropic.oauth-access" */
  id: string
  family: "secret" | "pii"
  /** Marker kind, "anthropic.oauth-access" */
  kind: string
  severity: Severity
  gate: Gate
  /** Lowercase. Every keyword 3+ chars when gate is "keyword" (self-test enforces). */
  keywords: readonly string[]
  /** JS regex source after the port checklist. Absent for known-value only rules. */
  pattern?: string
  /** "g" is added by the engine. Never "u" or "v". */
  flags?: "i" | ""
  /**
   * Capture group that holds the secret. Default 0. Public context that must stay
   * visible at mid (a URL host, a header name like "Authorization: Bearer ") goes
   * OUTSIDE this group: only the group span is replaced, so the rest of the match
   * stays as written. Auth-header and url-cred rules must use this. There is no
   * render.publicGroup.
   */
  group?: number
  /** Feeds the known-value index. */
  knownValue?: { keys: readonly string[] }
  /** One line, 120 chars or less. */
  explain: string
  validator?: ValidatorName
  /** Checked on the capture only. */
  entropy?: { min: number; charset: "b64" | "hex" }
  allow?: readonly AllowlistId[]
  /**
   * Opt in to the "stopwords" allowlist (substring match on the capture). Only for the
   * generic key/value rule. A rule with render.publicPrefix (a provider rule) may not set it.
   */
  allowStopwords?: true
  render: {
    /** Kept at low and mid. From the public format only. */
    publicPrefix?: string
    /**
     * Low level keeps n = min(4, floor(r/16)) tail chars, r = value length minus
     * publicPrefix. No tail when fewer than 12 random chars would stay hidden.
     */
    keepTail?: boolean
    /** Keep BEGIN and END lines at low and mid. */
    pem?: boolean
  }
  defaults: { status: Status; level: Level; min_len?: number }
  examples: { match: readonly Example[]; not_match: readonly Example[] }
  inspiredBy?: InspiredBy
  /**
   * Free text. Required (non-blank) for every gate other than "keyword": the reason.
   * "reviewed:<check>" opts out of one static shape check. Checks: "unbounded",
   * "nested", "lazy-prefix", "huge-bound", "overlap". The bench gate has no opt-out.
   */
  notes?: string
}

export type PathReadDecision = "allow" | "warn" | "deny" | "redact"
export type PathWriteDecision = "allow" | "warn" | "deny"
export type CmdDecision = "deny" | "warn"

/** Union of every decision a rule or a hook can give. */
export type Decision = "allow" | "warn" | "deny" | "redact" | "ask"

export type PathRule = {
  id: string
  family: "path"
  severity: Severity
  explain: string
  inspiredBy?: InspiredBy
  globs: readonly string[]
  except?: readonly string[]
  decision: { read: PathReadDecision; write: PathWriteDecision }
  contentCheck?: "pem-header"
  defaults: { status: Status }
  /** Paths. */
  examples: { match: readonly string[]; not_match: readonly string[] }
  notes?: string
}

/**
 * Minimal view of one parsed simple command. The guard worker adapts the parser
 * (src/parser) output to this shape.
 */
export interface ParsedSimpleCommand {
  /** Basename of the executable after unwrap ("rm", "git"). Empty when not static. */
  readonly basename: string
  /** Every word as text. Non-static words hold their raw source text. */
  readonly argv: readonly string[]
  /** Per argv index: true when the word is fully static. */
  readonly staticArgs: readonly boolean[]
  /** Normalized static flags: bundled short flags split, long flags as written ("-r", "--force"). */
  readonly flags: ReadonlySet<string>
  /** Static operands (non-flag words after argv[0]), in order. */
  readonly operands: readonly string[]
}

/** Context passed to a command matcher. */
export interface CmdCtx {
  /** Absolute working directory of the call. */
  readonly cwd: string
  /** Absolute home directory. */
  readonly home: string
  /** True when the command came from a partial tree after a parse failure. */
  readonly partial: boolean
}

export type CmdRule = {
  id: string
  family: "cmd"
  severity: Severity
  explain: string
  inspiredBy?: InspiredBy
  decision: CmdDecision
  /** Pure and sync. Only the engine calls it. */
  match: (cmd: ParsedSimpleCommand, ctx: CmdCtx) => boolean
  /** For the cmd.parse.unparseable raw-text fallback. */
  keywords: readonly string[]
  defaults: { status: Status }
  /** Shell lines. */
  examples: { match: readonly string[]; not_match: readonly string[] }
  notes?: string
}

export type AnyRule = RedactRule | PathRule | CmdRule

/**
 * Fixed reason for a disabled rule (registry.disabled). Never free text, so a reason can
 * never carry a secret value. "self-test" covers example, keyword, prefix and explain
 * failures that fit no other reason.
 */
export type DisabledReason =
  | "duplicate-id"
  | "marker-safety"
  | "compile-error"
  | "static-shape"
  | "example-cap"
  | "bench"
  | "self-test"
