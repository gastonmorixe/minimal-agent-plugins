/**
 * STE (ASD-STE100) prose rules for model-facing text.
 *
 * The rules are pure functions over masked prose, so the same engine can gate
 * the repo (scripts/ste-check.ts) and be unit-tested (ste-rules.test.ts).
 *
 * Rule ids are stable. The ratchet baseline in `ste-baseline.json` counts
 * violations per file and per rule id, so an id must not be renamed without a
 * baseline refresh.
 *
 * @module tests/ste/ste-rules
 */

/**
 * The role of a surface. `tool` is a tool `description` in `tools[]`, `param`
 * is a parameter description in a tool schema, `prose` is everything else
 * (PROMPT.md, prompts, plugin descriptions, core text). The tool block ships
 * on every request, so the tool and param roles are zero-tolerance.
 */
export type Role = "tool" | "param" | "prose"

/** One finding for one rule at one place in a text. */
export interface SteFinding {
  /** Stable rule id, for example `ste-s2-semicolon`. */
  rule: string
  /** Short human label. */
  message: string
  /** The offending text, shortened. */
  snippet: string
  /** 1-based line in the source file. */
  line: number
  /** `error` blocks a merge, `warn` records debt. */
  severity: "error" | "warn"
  /**
   * Character offset of the finding in the linted text. Exemptions use it
   * (EXEMPT_SNIPPETS). It is never written to the baseline.
   */
  offset?: number
  /** Role of the surface that gave the finding. */
  role?: Role
  /** Locator of the surface that gave the finding, for a report. */
  locator?: string
}

/** One sentence of a masked text, with offsets into the same-length raw text. */
export interface Span {
  /** Offset of the first character. */
  start: number
  /** Offset after the last character. */
  end: number
  /** The masked sentence text (`masked.slice(start, end)`). */
  text: string
  /** 1-based line of `start`, before any line offset. */
  line: number
  /** True when the sentence is a markdown heading. */
  heading: boolean
}

/** The wire tool names and the old names that the loader keeps as aliases. */
export interface ToolNameIndex {
  /** Canonical names, as the model sees them in `tools[]`. */
  wire: ReadonlySet<string>
  /** An old or migration name, mapped to its wire name. */
  aliasToWire: ReadonlyMap<string, string>
}

/** The input of an {@link ExtraFindings} hook: one surface text. */
export interface ExtraFindingsArgs {
  /** The masked text (`maskNonProse`), the same length as `raw`. */
  masked: string
  /** The raw surface text. */
  raw: string
  /** Add this to a 1-based line of the text to get the line in the file. */
  lineOffset: number
  /** Repo-relative file. */
  file: string
  /** Role of the surface. */
  role: Role
}

/**
 * A rule that lives outside this module (s19 dictionary, s20 tool names). It
 * gets one surface text and gives its findings. `lintText` calls it once per
 * text. `scripts/ste-check.ts` loads it from `tests/ste/extra-rules.ts`.
 */
export type ExtraFindings = (args: ExtraFindingsArgs) => SteFinding[]

/** Optional context for {@link lintText}. Every field has a safe default. */
export interface LintContext {
  /** Role of the surface. Default `prose`. */
  role?: Role
  /** Extra findings from an outside rule. Called once per text. */
  extraFindings?: ExtraFindings
  /**
   * Run s10 (one word for one meaning) on this text. Default true.
   * `reportByFile` sets it false and runs s10 once per file (bug B5).
   */
  termPairs?: boolean
  /**
   * A base-form verb test for the instruction classifier. Absent: the fixed
   * verb list. TODO(ste-s19): the lead wires `Dictionary.isVerb` here (R3 B11).
   */
  isVerb?: (word: string) => boolean
}

/** A rule pattern with its id, message and severity. */
interface WordRule {
  rule: string
  message: string
  pattern: RegExp
  severity: "error" | "warn"
}

/** An optional adverb between an auxiliary and a participle. */
const PP_ADVERB = "(?:(?:not|also|only|still|already|then|now)\\s+)?"

/** A past participle: a regular `-ed` form or an irregular one from the list. */
const PARTICIPLE =
  "(?:\\w+ed|done|made|sent|shown|given|taken|written|kept|held|built|read|withheld|hidden|known|chosen|cut|set|put|left|found|brought|thought|told|seen|heard|meant|spent|lost|won|paid|sold|drawn|grown|thrown|worn|torn|broken|spoken|frozen|driven|eaten|fallen|forgotten|gotten|born|laid|led|fled|fed|fought|sought|caught|taught|bound|wound|dug|hung|struck|stuck|stung|swum|sung|rung|drunk|shrunk|sunk|stolen|begun|become|come|gone)"

/**
 * Words and phrases that STE forbids or that the project glossary replaces.
 * The approved alternative is in the message, so the fix is never a guess.
 */
const WORD_RULES: readonly WordRule[] = [
  {
    rule: "ste-s4-banned-word",
    message: "use a plain word: utilize -> use, leverage -> use, facilitate -> help",
    pattern: /\b(?:utiliz(?:e|es|ed|ing)|leverag(?:e|es|ed|ing)|facilitat(?:e|es|ed|ing))\b/gi,
    severity: "error",
  },
  {
    rule: "ste-s4-banned-word",
    message: "use a plain word: robust -> reliable, seamless -> smooth",
    pattern: /\b(?:robust|seamless(?:ly)?)\b/gi,
    severity: "error",
  },
  {
    rule: "ste-s4-banned-word",
    message: "drop the connector: moreover, furthermore, additionally -> also",
    pattern: /\b(?:moreover|furthermore|additionally)\b/gi,
    severity: "error",
  },
  {
    rule: "ste-s4-banned-word",
    message: "use the approved word: ensure -> make sure, commence/initiate -> start",
    pattern: /\b(?:ensure[sd]?|ensuring|commence[sd]?|initiate[sd]?|initiating)\b/gi,
    severity: "error",
  },
  {
    rule: "ste-s4-banned-word",
    message: "use the approved word: prior to -> before, in order to -> to, in case -> if",
    pattern: /\b(?:prior to|in order to|in the event that|with regard to)\b/gi,
    severity: "error",
  },
  {
    rule: "ste-s5-phrasal-verb",
    message: "replace the phrasal verb with one verb",
    // A phrasal verb can be split: "turns every plugin on", "sets the mode up".
    // Allow up to three words between the verb and its particle.
    pattern:
      /\b(?:turn(?:s|ed|ing)?(?:\s+\w+){0,3}\s+(?:on|off)|set(?:s|ting)?(?:\s+\w+){0,3}\s+up|find(?:s|ing)?(?:\s+\w+){0,3}\s+out|look(?:s|ed|ing)?(?:\s+\w+){0,3}\s+at|rel(?:y|ies|ied|ying)(?:\s+\w+){0,3}\s+on|carry(?:ies|ied|ying)?(?:\s+\w+){0,3}\s+out|spin(?:s|ning)?(?:\s+\w+){0,3}\s+up|kick(?:s|ed|ing)?(?:\s+\w+){0,3}\s+off|reach(?:es|ed|ing)?(?:\s+\w+){0,3}\s+out|figure(?:s|d|ing)?(?:\s+\w+){0,3}\s+out|go(?:es|ing)?(?:\s+\w+){0,3}\s+in)\b/gi,
    severity: "warn",
  },
  {
    rule: "ste-s5-phrasal-verb",
    message:
      "replace the hyphen-joined phrasal verb with one verb: set-up -> set, find-out -> find, look-up -> find",
    // REVIEW-C M5: a hyphen does not hide a phrasal verb ("Find-out the
    // look-up set-up."). The verbs are those of the split pattern above, plus
    // the particles that STE replaces.
    pattern:
      /(?<![\w-])(?:turn(?:s|ed|ing)?|set(?:s|ting)?|find(?:s|ing)?|look(?:s|ed|ing)?|rel(?:y|ies|ied|ying)|carr(?:y|ies|ied|ying)|spin(?:s|ning)?|kick(?:s|ed|ing)?|reach(?:es|ed|ing)?|figure(?:s|d)?|figuring|go(?:es|ing)?)-(?:on|off|up|out|at|in)(?![\w-])/gi,
    severity: "warn",
  },
  {
    rule: "ste-s6-contraction",
    message: "do not use a contraction: write cannot, does not, it is",
    // General (REVIEW-C M3): any word + 't (n't), 'll, 'd, 've, 're or 'm is a
    // contraction. A trailing 's is a possessive, except on the closed list of
    // pronoun and adverb forms (it's, that's, let's ...), which are always
    // contractions. `maskForWords` turns a curly apostrophe into `'` first.
    pattern:
      /\b(?:[A-Za-z]+'(?:t|ll|d|ve|re|m)|it's|that's|let's|here's|there's|what's|who's|where's|he's|she's)\b/gi,
    severity: "error",
  },
  // STE 3.3: `be` + a past participle after `is`/`are` is an adjective of
  // condition ("the file is installed"), not the passive. R1 3.3/3.4/3.6: flag
  // only the forms that STE forbids: a known agent (`by`), a modal + `be` + pp,
  // `is to be` + pp, and `been`/`being` + pp (a perfect or progressive passive).
  {
    rule: "ste-s7-passive",
    message: "use the active voice: the agent is known (by ...), so name it as the subject",
    pattern: new RegExp(
      `\\b(?:is|are|was|were|be|been|being)\\s+${PP_ADVERB}${PARTICIPLE}\\s+by\\b`,
      "gi",
    ),
    severity: "warn",
  },
  {
    rule: "ste-s7-passive",
    message:
      "do not use a complex verb (can/must/will be + participle): write 'you can do X' (STE 3.4)",
    pattern: new RegExp(
      `\\b(?:can|cannot|must|will|should|may|might|would|could)\\s+(?:not\\s+)?be\\s+${PP_ADVERB}${PARTICIPLE}\\b`,
      "gi",
    ),
    severity: "warn",
  },
  {
    rule: "ste-s7-passive",
    message: "do not use a complex verb (is to be / been / being + participle) (STE 3.2, 3.4)",
    pattern: new RegExp(
      `\\b(?:(?:is|are|was|were)\\s+to\\s+be|been|being)\\s+${PP_ADVERB}${PARTICIPLE}\\b`,
      "gi",
    ),
    severity: "warn",
  },
  {
    rule: "ste-s14-abbreviation",
    message:
      "write the words: e.g. -> for example, i.e. -> that is, etc -> name the items, approx -> approximately, cf -> see, w/o -> without (STE GR-6)",
    pattern:
      /(?<![\w./-])(?:e\.\s?g\.?|i\.\s?e\.?|etc\b\.?|approx\b\.?|cf\b\.|w\/o\b|w\/(?=\s))(?![\w/])/gi,
    severity: "error",
  },
  {
    rule: "ste-s14-abbreviation",
    message: "write the words: vs -> or, or compared with (STE GR-6)",
    // Lower case only, so the product name `VS Code` stays quiet.
    pattern: /(?<![\w./-])vs\b\.?(?![\w/])/g,
    severity: "error",
  },
  {
    rule: "ste-s17-modal",
    message:
      "use an approved modal: may/might -> can or possibly, should/shall -> must, would -> can or will (STE Part 2)",
    // Lower case only: `May 2026` is a month, and an RFC keyword is upper case.
    pattern: /\b(?:may|might|should|shall|would)\b(?!\s+\d)/g,
    severity: "error",
  },
  {
    rule: "ste-s17-modal",
    message:
      "use an approved modal: may/might -> can or possibly, should/shall -> must, would -> can or will (STE Part 2)",
    // A capitalized modal only at a sentence or list-item start.
    pattern:
      /(?:(?<=^[ \t]*)|(?<=^[ \t]*(?:[-*+]|\d+[.)])[ \t]+)|(?<=[.!?:][ \t]+))(?:May|Might|Should|Shall|Would)\b(?!\s+\d)/g,
    severity: "error",
  },
  {
    rule: "ste-s17-modal",
    message: "'could' is the past of 'can' only: use 'can' for a present possibility",
    pattern: /\bcould\b/gi,
    severity: "warn",
  },
  {
    rule: "ste-s8-shout-case",
    message: "do not use shout case for emphasis",
    // A fixed list catches the usual directives. The run pattern catches any
    // other shout, for example "CONTEXT CHECKPOINT COMPACTION". A true acronym
    // (ACP, MCP, JSON, the rule keyword MUST) is not shout case.
    pattern:
      /\b(?:ALWAYS|NEVER|IMPORTANT|REQUIRED|MUST|SHOULD|ONLY|BACKGROUND|GENERIC|DETAILED|CURRENT|LIVE|LATEST|RECORDED|FINAL)\b|\b[A-Z]{4,}(?:[ \t]+[A-Z]{2,}){1,}\b/g,
    severity: "warn",
  },
  {
    rule: "ste-s9-sycophancy",
    message: "remove filler, flattery and signposting",
    pattern:
      /\b(?:great question|let me know if you|i hope this helps|as an ai language model|let's dive in|without further ado|please note that|it is important to note that|at this point in time|due to the fact that)\b/gi,
    severity: "error",
  },
]

/**
 * Rules that the surface may contain only these characters.
 *
 * Every prompt byte reaches the model, and a hidden or lookalike character can
 * change what a reader (or a lint rule) sees without changing the words. Five
 * review rounds found them one at a time: a soft hyphen, a zero-width space, a
 * modifier apostrophe, a fullwidth apostrophe, and then 49 more that a list
 * would never finish.
 *
 * So this is an allowlist, not a blocklist: printable ASCII, newline, tab, and
 * the six non-ASCII characters that the corpus really uses. A new character
 * fails until someone adds it here with a reason, which is the review the
 * change deserves.
 */
/**
 * Per-file allowlist entries. A character is allowed only in the file that
 * needs it, and each entry carries the reason, so the next addition copies the
 * pattern instead of widening a global set.
 */
const ALLOWED_BY_FILE: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  [
    "ma-agent-writing-style-plugin/PROMPT.md",
    new Map([
      ["\u201c", "the file quotes the em dash and curly-quote ban examples"],
      ["\u201d", "same example list"],
      ["\u2018", "same example list"],
      ["\u2019", "same example list"],
    ]),
  ],
  [
    "ma-slash-menu-plugin/manifest.json",
    new Map([
      ["\u2191", "the command-menu key hints name the up arrow"],
      ["\u2193", "the command-menu key hints name the down arrow"],
    ]),
  ],
])

/**
 * Characters allowed in every file. Keep this empty unless a character is
 * genuinely universal; a per-file entry is the stronger form.
 */
const ALLOWED_EVERYWHERE: ReadonlyMap<string, string> = new Map()

/**
 * Report a character that is not allowed in this file.
 *
 * @param line - One line of raw text.
 * @param file - Repo-relative file, for the per-file allowlist.
 * @returns Each disallowed character, with its code point.
 */
function hiddenCharacters(line: string, file: string): string[] {
  const perFile = ALLOWED_BY_FILE.get(file)
  const out: string[] = []
  for (const char of line) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0x0a || code === 0x09) continue
    if (code >= 0x20 && code <= 0x7e) continue
    if (ALLOWED_EVERYWHERE.has(char)) continue
    if (perFile?.has(char)) continue
    out.push(char)
  }
  return out
}

/**
 * Rules that judge a word, not a sentence shape. They run on text that keeps
 * the inside of a backtick span, because these words never appear in code.
 */
const VOCABULARY_RULES = new Set(["ste-s4-banned-word", "ste-s6-contraction", "ste-s9-sycophancy"])

/** Pairs that must not both appear in one file, because STE keeps one word per meaning. */
const TERM_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["begin", "start"],
  ["terminate", "stop"],
  ["ensure", "make sure"],
  ["utilize", "use"],
  ["inspect", "examine"],
  ["additionally", "also"],
]

/** Sentence limits from STE rule 4.1 and 6.x. */
export const INSTRUCTION_WORDS = 20
/** Descriptive sentence limit from STE rule 4.1. */
export const DESCRIPTIVE_WORDS = 25

/** STE rule 6.6: the maximum number of sentences in one paragraph. */
export const PARAGRAPH_SENTENCES = 6

/**
 * Rule ids that other modules emit through {@link LintContext.extraFindings}.
 * They are listed here so the corpus knows every id.
 */
export const EXTRA_RULE_IDS: readonly string[] = [
  "ste-s19-dictionary",
  "ste-s20-tool-name",
  "ste-s23-pos",
]

/** Every rule id the engine can emit, plus the ones added outside the table. */
export const RULE_IDS: readonly string[] = [
  ...new Set([
    ...WORD_RULES.map((rule) => rule.rule),
    "ste-s1-long-sentence",
    "ste-s2-semicolon",
    "ste-s3-typographic",
    "ste-s10-inconsistent-term",
    "ste-s11-empty-surface",
    "ste-s12-hidden-char",
    "ste-s13-paragraph",
    "ste-s15-slash",
    "ste-s16-progressive",
    "ste-s18-fragment",
    "ste-s21-result-verb",
    ...EXTRA_RULE_IDS,
  ]),
].sort()

/** A line that starts like a numbered rule (`INS-01 MUST ...`) may use its keyword. */
const RULE_KEYWORD_LINE = /^[A-Z]+-\d{2}(?: \[\w+\])?\b/

/**
 * Replace code, URLs, tags and placeholders with spaces. Newlines stay, so
 * every line number still matches the source file.
 *
 * @param text - Raw file or string content.
 * @returns Text of the same length, with non-prose parts blanked.
 */
export function maskNonProse(text: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, " ")
  // A code span, tag, placeholder, path or URL is one item, so it becomes one
  // word. Padding keeps the column count, and only a newline can change that.
  const oneWord = (s: string): string => (s.length <= 1 ? "W" : `W${" ".repeat(s.length - 1)}`)
  // A backtick span can hold code OR quoted prose. Mask only the code shape:
  // no spaces, or a call/flag/path/type shape. A span with spaces and no code
  // markers is prose that a reader must judge, for example a banned example
  // string or an instruction in quotes.
  const codeSpan = (whole: string, inner: string): string =>
    looksLikeCode(inner) ? oneWord(whole) : whole
  return (
    text
      // A wire header (`key: k=v; k=v;`) is protocol, not prose.
      .replace(/^[a-z][\w-]*:[ \t]*\S+=\S+(?:;[ \t]*\S+=\S*)+;?[ \t]*$/gm, blank)
      .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, blank)
      .replace(/`([^`\n]*)`/g, codeSpan)
      .replace(/\$\{[^}\n]*\}/g, oneWord)
      .replace(/%%[A-Za-z0-9_]+%%/g, oneWord)
      .replace(/<ma::[\s\S]*?\/?>/g, oneWord)
      .replace(/\bhttps?:\/\/\S+/g, oneWord)
      .replace(PATH_LIKE, (match: string, at: number, all: string) =>
        isPath(match, all[at - 1]) ? oneWord(match) : match,
      )
  )
}

/** A token with a slash: a path candidate. {@link isPath} decides. */
const PATH_LIKE = /\b[\w.-]+\/[\w./-]+\b/g

/**
 * True when a `x/y` token is a path, not two prose words with a slash.
 *
 * A path has a dot, a digit, an underscore, a `~`, a leading `/` or `~` (the
 * character before the token), or a trailing `/`. Two plain words with a
 * slash (`robust/seamless`, `and/or`, `low/medium/high`) are prose, so the
 * vocabulary rules and s15 judge them (bug B4).
 *
 * @param token - The matched token.
 * @param before - The character before the token, if any.
 * @returns True when the token is masked as one code word.
 */
export function isPath(token: string, before: string | undefined): boolean {
  if (before === "/" || before === "~" || before === "." || before === "$") return true
  return /[.\d_~]/.test(token) || token.endsWith("/")
}

/** A command that starts a shell line, so the span is code even with plain words. */
const COMMAND_START =
  /^(?:git|bun|bunx|npm|npx|pnpm|yarn|node|deno|ls|cat|grep|rg|fd|head|tail|wc|sed|awk|curl|export|kill|docker|cd|rm|cp|mv|mkdir|chmod|ssh|psql|sqlite3|echo|printf|unset|source|bash|sh|zsh)\b/

/** Unicode spaces that would otherwise split or join a span by accident. */
const UNICODE_SPACES = /[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g

/**
 * Mask for the vocabulary rules only.
 *
 * A banned word, a contraction or a filler phrase does not appear in real code,
 * so these rules read the text inside a backtick span too. That closes the one
 * hole the classifier cannot close: hiding "utilize" or "moreover" in a span
 * that looks like code. Fences, tags, URLs, paths and placeholders stay masked,
 * because those really are identifiers.
 *
 * @param text - Raw file or string content.
 * @returns Text of the same length, with only the non-word parts blanked.
 */
export function maskForWords(text: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, " ")
  const oneWord = (s: string): string => (s.length <= 1 ? "W" : `W${" ".repeat(s.length - 1)}`)
  // A curly apostrophe is a contraction, and an invisible character inside a
  // word hides a banned word: "util\u00adize" must read as "utilize".
  const normalized = text
    .replace(/[\u2019\u02bc\uff07]/g, "'")
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
  return normalized
    .replace(/^[a-z][\w-]*:[ \t]*\S+=\S+(?:;[ \t]*\S+=\S*)+;?[ \t]*$/gm, blank)
    .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, blank)
    .replace(/\$\{[^}\n]*\}/g, oneWord)
    .replace(/%%[A-Za-z0-9_]+%%/g, oneWord)
    .replace(/<ma::[\s\S]*?\/?>/g, oneWord)
    .replace(/\bhttps?:\/\/\S+/g, oneWord)
    .replace(PATH_LIKE, (match: string, at: number, all: string) =>
      isPath(match, all[at - 1]) ? oneWord(match) : match,
    )
}

/**
 * True when a backtick span is code, not quoted prose.
 *
 * A span that is mostly plain words is prose, even with one code character.
 * Otherwise the span keeps the code shape: no spaces, or a call, flag, path,
 * JSON shape, shell command or statement.
 *
 * @param inner - Text between the backticks.
 * @returns True when the span should be masked as one code word.
 */
export function looksLikeCode(inner: string): boolean {
  const text = inner.replace(UNICODE_SPACES, " ").trim()
  if (text.length === 0) return true

  // Two strict shapes win before anything else. A shell loop is unmistakable,
  // and a command word must be followed by an argument, so "make sure we
  // utilize it" stays prose.
  if (/^(?:for|while)\s+\S+\s+in\b[\s\S]*;\s*do\b/.test(text)) return true
  if (COMMAND_START.test(text)) return true
  // A statement in upper-case SQL keywords is code, even with plain words.
  if (
    /^(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\s+/.test(text) &&
    /\b(?:FROM|INTO|SET|WHERE|VALUES)\b/.test(text)
  ) {
    return true
  }

  // Then decide by proportion. A span that is mostly plain words is prose, even
  // when it holds a brace, a semicolon, a colon or an assignment. This is the
  // rule that stops bad prose hiding behind one code character.
  const tokens = /\s/.test(text) ? text.split(/\s+/) : text.split(/-+/)
  const plain = tokens.filter((token) => /^[A-Za-z][a-z']*[.,!?;:]?$/.test(token))
  // Three plain words are enough to read a span as prose. A hyphen chain was
  // split into words above, so it needs no separate threshold.
  const needPlain = 3
  if (plain.length >= needPlain && plain.length / tokens.length >= 0.6) {
    // A span that is mostly words is code only when it carries REAL JSON or
    // REAL SQL. A brace alone, or a leading keyword in lower case, is prose.
    if (/"[^"]+"\s*:/.test(text) || /:\s*(?:"|\{|\[|\d)/.test(text)) return true
    if (
      /^(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\s+/.test(text) &&
      /\b(?:FROM|INTO|SET|WHERE|VALUES)\b/.test(text)
    ) {
      return true
    }
    return false
  }

  // Not mostly words: keep the code shapes.
  if (/^[A-Za-z_][\w.[\]]*\s*:\s*["'{[]/.test(text)) return true
  // No whitespace: an identifier, a flag, a command, a type.
  if (!/\s/.test(text)) return true
  // A call, a flag, a path, a JSON or code shape, or a shell word.
  if (/[A-Za-z_][\w.[\]]*\(|\{|\}|=>|===|==|&&|\|\||\\|::|\$\d|[|>]/.test(text)) return true
  if (/(?:^|\s)-{1,2}[A-Za-z]/.test(text)) return true
  if (/\//.test(text) && !/\.\s|\s[A-Z][a-z]+\s/.test(text)) return true
  // Shell: a lowercase command word, then arguments, then `;` or a quote.
  if (/^[a-z][\w.-]*(?:\s+\S+)*\s*;/.test(text)) return true
  if (/^[a-z][\w.-]+\s+[^A-Z]*['"=]/.test(text)) return true
  // An assignment or an expression.
  if (/^[A-Za-z_][\w.]*\s*=\s*\S/.test(text)) return true
  return false
}

/** A list marker or a heading marker at the start of a line. */
const LINE_MARKER = /^[ \t]*(?:[-*+]|\d+[.)]|#{1,6})\s*/

/** Abbreviations and labels that do not end a sentence. */
const NO_SPLIT_BEFORE = /\b(?:e\.g|i\.e|etc|vs|cf|approx|No|Fig|L)\.$/i

/**
 * Split masked text into sentences, with offsets into the same-length raw text.
 *
 * A bullet or a heading marker starts a sentence. `.`, `!` or `?` and then a
 * space and `[A-Z0-9"'([]` ends it. Because `maskNonProse` keeps the length,
 * `raw.slice(span.start, span.end)` is the raw form of the same sentence. That
 * fixes bug B1 (the raw and masked splits used to differ) and bug B3 (a line
 * number from `indexOf` found the first copy of a repeated sentence).
 *
 * @param masked - Masked text.
 * @returns One span for each sentence, in order.
 */
export function sentenceSpans(masked: string): Span[] {
  const out: Span[] = []
  let lineStart = 0
  const lines = masked.split("\n")
  for (const [index, line] of lines.entries()) {
    const marker = LINE_MARKER.exec(line)?.[0] ?? ""
    const heading = /^[ \t]*#{1,6}(?:\s|$)/.test(line)
    const body = line.slice(marker.length)
    const base = lineStart + marker.length
    const push = (from: number, to: number): void => {
      const slice = body.slice(from, to)
      const lead = slice.length - slice.trimStart().length
      const text = slice.trim()
      if (!text) return
      const start = base + from + lead
      out.push({ start, end: start + text.length, text, line: index + 1, heading })
    }
    let from = 0
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]
      if (ch !== "." && ch !== "!" && ch !== "?") continue
      const next = body[i + 1]
      const after = body[i + 2]
      if (next !== undefined && next !== " ") continue
      // An abbreviation or a version number does not end a sentence.
      if (NO_SPLIT_BEFORE.test(body.slice(from, i + 1))) continue
      if (next === " " && after !== undefined && !/[A-Z0-9"'([]/.test(after)) continue
      push(from, i + 1)
      from = i + 1
    }
    push(from, body.length)
    lineStart += line.length + 1
  }
  return out
}

/**
 * Split masked prose into sentences.
 *
 * @param text - Masked text.
 * @returns One entry for each sentence, in order.
 */
export function splitSentences(text: string): string[] {
  return sentenceSpans(text).map((span) => span.text)
}

/**
 * Count the words of a sentence. A placeholder or a masked code span counts
 * as one word.
 *
 * @param sentence - One sentence.
 * @returns The word count.
 */
export function wordCount(sentence: string): number {
  return sentence.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length
}

/** The first-verb list of the instruction classifier. */
const INSTRUCTION_START =
  /^(?:do|use|set|start|stop|read|write|call|make|keep|run|send|give|put|add|remove|check|examine|return|reply|continue|pause|ask|tell|show|open|close|never|always|if)\b/i

/**
 * True when the sentence reads as an instruction, not as a description.
 *
 * @param sentence - The raw sentence.
 * @param isVerb - Optional base-form verb test (the dictionary, R3 B11).
 */
function isInstruction(sentence: string, isVerb?: (word: string) => boolean): boolean {
  // Case-insensitive: after a leading clause the verb can read lowercase.
  if (INSTRUCTION_START.test(sentence)) return true
  const first = /^([A-Z][a-z]+)\b/.exec(sentence)?.[1]
  if (first && isVerb?.(first.toLowerCase())) return true
  // An imperative behind a leading clause keeps the instruction limit:
  // "To show all tracked files, do not set `status`." is still an instruction.
  const leading = /^(?:When|While|If|To|For|After|Before|Unless|Because|Since)\b[^,]*,\s*/
  const rest = sentence.replace(leading, "")
  return rest !== sentence && INSTRUCTION_START.test(rest)
}

/** The 1-based line of an offset in a text. */
function lineAt(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++
  return line
}

// ---------------------------------------------------------------------------
// s13 paragraph
// ---------------------------------------------------------------------------

/** One paragraph of a masked text. */
export interface Paragraph {
  /** Offset of the first character. */
  start: number
  /** Offset after the last character. */
  end: number
  /** `item` is one list item, `prose` is a block of text. */
  kind: "prose" | "item"
  /** 1-based line of `start`. */
  line: number
}

/**
 * Split masked text into paragraphs (STE 6.6).
 *
 * A blank line, a heading, a table row and a horizontal rule close a paragraph
 * and are not part of one. A list item opens its own paragraph: STE reads a
 * list item as a unit, and the lead-in sentence of a list is its own
 * paragraph. Any other line continues the open paragraph (a hard wrap, or the
 * lazy continuation of a list item). A fence is masked to blank lines first.
 *
 * @param masked - Masked text.
 * @returns The paragraphs, in order.
 */
export function paragraphs(masked: string): Paragraph[] {
  const out: Paragraph[] = []
  let open: Paragraph | undefined
  let offset = 0
  const close = (): void => {
    if (open) out.push(open)
    open = undefined
  }
  for (const [index, line] of masked.split("\n").entries()) {
    const end = offset + line.length
    if (
      !line.trim() ||
      /^[ \t]*#{1,6}(?:\s|$)/.test(line) ||
      /^\s*\|/.test(line) ||
      /^\s*(?:-{3,}|\*{3,})\s*$/.test(line)
    ) {
      close()
    } else if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      close()
      open = { start: offset, end, kind: "item", line: index + 1 }
    } else if (open) {
      open.end = end
    } else {
      open = { start: offset, end, kind: "prose", line: index + 1 }
    }
    offset = end + 1
  }
  close()
  return out
}

/** s13: every paragraph with more than {@link PARAGRAPH_SENTENCES} sentences. */
function paragraphFindings(
  masked: string,
): Array<{ offset: number; snippet: string; count: number }> {
  const out: Array<{ offset: number; snippet: string; count: number }> = []
  for (const p of paragraphs(masked)) {
    // A hard-wrapped sentence is one sentence: join the lines first. The
    // join keeps the length, so offsets stay valid. A `>` quote marker goes.
    const text = masked
      .slice(p.start, p.end)
      .replace(/\n[ \t]*>?/g, (m) => " ".repeat(m.length))
      .replace(/^[ \t]*>/, " ")
    const count = sentenceSpans(text).length
    if (count <= PARAGRAPH_SENTENCES) continue
    out.push({ offset: p.start, snippet: text.trim().slice(0, 80), count })
  }
  return out
}

// ---------------------------------------------------------------------------
// s15 slash
// ---------------------------------------------------------------------------

/** A time or rate unit after a slash (`KB/s`, `req/min`): not an "or". */
const SLASH_UNIT = /^(?:s|ms|us|ns|sec|min|h|hr|d|day|op|req|tok|line)$/i

/**
 * ACP protocol method namespaces (`session/new`). The author should put a
 * method in backticks. This list exists so that protocol text does not force
 * a rewrite on the first landing.
 */
export const PROTOCOL_NAMESPACES: ReadonlySet<string> = new Set([
  "session",
  "text",
  "textDocument",
  "fs",
  "terminal",
  "authenticate",
  "initialize",
])

/**
 * Two or more words joined by a slash, in masked prose. The separator is `/`
 * or ` / `. A space on one side only is a slash command (`run /config`).
 */
const SLASH_WORDS =
  /(?<![\w.~:%/-])([A-Za-z][A-Za-z-]*)(?:(?:\/|[ \t]\/[ \t])([A-Za-z][A-Za-z-]*))+(?![\w/]|\.\w)/g

/** Two or more code spans joined by a slash, in raw text (x and y in backticks). */
const SLASH_SPANS = /`[^`\n]+`(?:[ \t]?\/[ \t]?`[^`\n]+`)+/g

/**
 * s15: `word/word` where the slash means "or" or "and" (house rule, R1 9).
 *
 * The scan reads the MASKED text, so a path, a URL and a code span are one
 * `W` word already. Quiet: a number, a unit (`KB/s`), a flag (`-A/-B`), a
 * slash command (`/config`), a protocol method (`session/new`). Two code spans
 * with a slash (x and y in backticks, then a slash) fire: that is "x or y" in prose.
 *
 * @param masked - Masked text.
 * @param raw - Raw text, the same length.
 * @returns Each slash pair with its offset.
 */
export function slashFindings(
  masked: string,
  raw: string,
): Array<{ offset: number; snippet: string }> {
  const out: Array<{ offset: number; snippet: string }> = []
  for (const match of masked.matchAll(SLASH_WORDS)) {
    const parts = match[0].split("/").map((part) => part.trim())
    if (parts.some((part) => part.startsWith("-"))) continue
    if (parts.length === 2 && SLASH_UNIT.test(parts[1] ?? "")) continue
    if (/^w\/o$/i.test(match[0])) continue // s14 owns `w/o`
    if (PROTOCOL_NAMESPACES.has(parts[0] ?? "")) continue
    out.push({ offset: match.index ?? 0, snippet: match[0] })
  }
  for (const match of raw.matchAll(SLASH_SPANS)) {
    const at = match.index ?? 0
    // A span inside a fence is blank in the mask: not prose.
    if (masked[at] === " ") continue
    out.push({ offset: at, snippet: match[0].slice(0, 80) })
  }
  return out.sort((a, b) => a.offset - b.offset)
}

// ---------------------------------------------------------------------------
// s16 progressive
// ---------------------------------------------------------------------------

/**
 * Words that end in -ing and are not a verb form in our text: nouns,
 * adjectives, a pronoun and a preposition. R1 3.5 approves `missing`,
 * `remaining`, `something`, `during` and a few more. TODO(ste-s19): derive
 * this set from the dictionary (TN entries and approved nouns).
 */
export const ING_NOT_VERB: ReadonlySet<string> = new Set([
  "string",
  "substring",
  "thing",
  "nothing",
  "anything",
  "everything",
  "something",
  "setting",
  "warning",
  "padding",
  "ceiling",
  "sibling",
  "heading",
  "meaning",
  "wording",
  "finding",
  "pricing",
  "caching",
  "logging",
  "streaming",
  "tracing",
  "thinking",
  "reasoning",
  "hardening",
  "monitoring",
  "during",
  "bring",
  "missing",
  "pending",
  "existing",
  "remaining",
  "trailing",
  "recurring",
  "interesting",
  "outstanding",
  "upcoming",
  "incoming",
  "ongoing",
])

/**
 * The -ing words that can follow `be` and still not make a progressive: the
 * adjectives and the nouns that are never a verb. `is running` fires,
 * `is missing` and `is nothing` stay quiet.
 */
const ING_AFTER_BE_OK: ReadonlySet<string> = new Set([
  "string",
  "substring",
  "thing",
  "nothing",
  "anything",
  "everything",
  "something",
  "ceiling",
  "sibling",
  "during",
  "missing",
  "pending",
  "existing",
  "remaining",
  "trailing",
  "recurring",
  "interesting",
  "outstanding",
  "upcoming",
  "incoming",
  "ongoing",
])

/** P1: `be` + an -ing form (STE 3.2 forbids the progressive). */
const PROGRESSIVE =
  /\b(?:am|is|are|was|were|be|been|being)\s+(?:(?:not|still|already|now|also|currently)\s+)?([a-z]{2,}ing)\b/g

/** P2: a sentence that opens with an -ing clause (`Using the cache, ...`). */
const ING_CLAUSE = /^(?:By\s+([a-z]+ing)|([A-Z][a-z]+ing))\b[^,]*,/

/**
 * s16: the -ing form used as a verb (STE 3.2, 3.5).
 *
 * @param span - One masked sentence.
 * @returns Each finding, with its offset in the text.
 */
export function progressiveFindings(
  span: Span,
): Array<{ offset: number; snippet: string; pattern: "P1" | "P2" }> {
  const out: Array<{ offset: number; snippet: string; pattern: "P1" | "P2" }> = []
  const lower = span.text.toLowerCase()
  for (const match of lower.matchAll(PROGRESSIVE)) {
    if (ING_AFTER_BE_OK.has(match[1] ?? "")) continue
    const at = match.index ?? 0
    out.push({
      offset: span.start + at,
      snippet: span.text.slice(at, at + match[0].length),
      pattern: "P1",
    })
  }
  const clause = ING_CLAUSE.exec(span.text)
  if (clause && !ING_NOT_VERB.has((clause[1] ?? clause[2] ?? "").toLowerCase())) {
    out.push({ offset: span.start, snippet: clause[0].slice(0, 60), pattern: "P2" })
  }
  return out
}

// ---------------------------------------------------------------------------
// s18 fragment, s21 result verb
// ---------------------------------------------------------------------------

/**
 * A label sentence: a table-cell label that STE allows (`Required.`,
 * `Default: false.`, `Example: j2.`). It is never a fragment.
 */
export const LABEL_SENTENCE =
  /^(?:Required|Optional|Default(?:s to\b| is\b|:)|Examples?:|Alias for\b|Max(?:imum)?\b|Min(?:imum)?\b|Note:)/

/** A 3rd-person verb that opens a sentence with no subject (`Reads a file`). */
export const SUBJECTLESS_VERBS: ReadonlySet<string> = new Set(
  (
    "returns gives takes reads writes runs replaces finds searches reports supports accepts sets " +
    "affects shows lists gets creates deletes sends opens closes starts stops prints removes adds " +
    "fetches renders saves loads checks uses makes keeps calls moves copies counts matches controls " +
    "drives queues schedules"
  ).split(" "),
)

/** F1: a sentence that opens with a coordinating conjunction. */
const CONJUNCTION_START = /^(?:And|Or|But|So|Nor|Yet)\b/

/** A result sentence in the tool role (D5). */
const RESULT_SENTENCE = /^(?:(?:The tool|This tool|It)\s+(?:returns?|gives?)|Returns|Gives)\b/

/** The one result sentence form that the tool role allows (D5). */
const CANONICAL_RESULT = /^The tool gives\b/

/**
 * s18 F1 and F2 for one sentence.
 *
 * F1: the sentence opens with And, Or, But, So, Nor or Yet. F2: the sentence
 * opens with a 3rd-person verb and has no subject (`Takes no input.`). In the
 * tool role, `Returns` and `Gives` belong to s21 (one finding per defect).
 *
 * @param span - One masked sentence.
 * @param role - Role of the surface.
 * @returns The fragment kind, or undefined.
 */
export function fragmentKind(span: Span, role: Role): "F1" | "F2" | undefined {
  if (span.heading) return undefined
  const text = span.text
  if (CONJUNCTION_START.test(text)) return "F1"
  if (LABEL_SENTENCE.test(text)) return undefined
  const first = /^([A-Z][a-z]+)\b/.exec(text)?.[1]
  if (!first) return undefined
  const lower = first.toLowerCase()
  if (!SUBJECTLESS_VERBS.has(lower)) return undefined
  if (role === "tool" && (lower === "returns" || lower === "gives")) return undefined
  return "F2"
}

/**
 * s21: in the tool role, a result sentence must read "The tool gives ..." (D5).
 *
 * @param span - One masked sentence.
 * @param role - Role of the surface.
 * @returns True when the sentence is a result sentence in another form.
 */
export function badResultSentence(span: Span, role: Role): boolean {
  if (role !== "tool" || span.heading) return false
  return RESULT_SENTENCE.test(span.text) && !CANONICAL_RESULT.test(span.text)
}

// ---------------------------------------------------------------------------
// lintText
// ---------------------------------------------------------------------------

/** Rules whose prose-role severity is `warn` (recorded debt, DESIGN 2). */
const PROSE_WARN_RULES: ReadonlySet<string> = new Set([
  "ste-s13-paragraph",
  "ste-s15-slash",
  "ste-s16-progressive",
  "ste-s18-fragment",
])

/**
 * Apply every STE rule to one text.
 *
 * In the tool and param roles every finding is an error (DESIGN D2). The
 * ratchet also never records them in the baseline.
 *
 * @param text - Raw text, before masking.
 * @param lineOffset - Shifts line numbers, for text inside a larger file.
 * @param file - Repo-relative path, for the per-file character allowlist.
 * @param ctx - Role and optional hooks. The default is the prose role.
 * @returns Every finding, in file order.
 */
export function lintText(
  text: string,
  lineOffset = 0,
  file = "",
  ctx: LintContext = {},
): SteFinding[] {
  const role: Role = ctx.role ?? "prose"
  const masked = maskNonProse(text)
  // Vocabulary rules read the words inside a code span too: real code does not
  // contain "utilize" or "moreover", so this cannot misfire, and it makes
  // hiding a banned word in a code-looking span impossible.
  const wordLines = maskForWords(text).split("\n")
  // The character allowlist is about bytes, not prose, so it reads the RAW
  // line. Masking would blank the code spans, tags and URLs, which are the
  // places a hidden character is most likely to do damage.
  const rawLines = text.split("\n")
  const lines = masked.split("\n")
  const findings: SteFinding[] = []
  const add = (
    rule: string,
    message: string,
    snippet: string,
    offset: number,
    severity: "error" | "warn",
  ): void => {
    findings.push({
      rule,
      message,
      snippet,
      line: lineAt(text, offset) + lineOffset,
      severity,
      offset,
      role,
    })
  }

  let lineStart = 0
  lines.forEach((line, index) => {
    const wordLine = wordLines[index] ?? line
    for (const rule of WORD_RULES) {
      const vocabulary = VOCABULARY_RULES.has(rule.rule)
      const target = vocabulary ? wordLine : line
      rule.pattern.lastIndex = 0
      for (const match of target.matchAll(rule.pattern)) {
        if (rule.rule === "ste-s8-shout-case" && RULE_KEYWORD_LINE.test(line.trim())) continue
        if (rule.rule === "ste-s17-modal" && RULE_KEYWORD_LINE.test(line.trim())) continue
        add(rule.rule, rule.message, match[0], lineStart + (match.index ?? 0), rule.severity)
      }
    }
    if (line.includes(";")) {
      add(
        "ste-s2-semicolon",
        "write two sentences instead of a semicolon",
        line.trim().slice(0, 80),
        lineStart + line.indexOf(";"),
        "error",
      )
    }
    const hidden = hiddenCharacters(rawLines[index] ?? line, file)
    if (hidden.length > 0) {
      const points = hidden.map(
        (c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
      )
      add(
        "ste-s12-hidden-char",
        "character is not on the allowlist: add it here with a reason if it is intentional",
        `${points.join(" ")} ${hidden.join("")}`,
        lineStart,
        "error",
      )
    }
    const typographic = line.match(/[\u2014\u2013\u201c\u201d\u2018\u2019\u2026\u2192]/g)
    if (typographic) {
      add(
        "ste-s3-typographic",
        "use plain ASCII punctuation",
        typographic.join(""),
        lineStart + line.search(/[\u2014\u2013\u201c\u201d\u2018\u2019\u2026\u2192]/),
        "error",
      )
    }
    lineStart += line.length + 1
  })

  // One span list for every sentence rule. The raw sentence is the same slice
  // of the raw text, so the classifier reads the SAME sentence (bug B1).
  const spans = sentenceSpans(masked)
  for (const span of spans) {
    const words = wordCount(span.text)
    const raw = text.slice(span.start, span.end)
    const limit = isInstruction(raw, ctx.isVerb) ? INSTRUCTION_WORDS : DESCRIPTIVE_WORDS
    if (words > limit) {
      add(
        "ste-s1-long-sentence",
        `sentence has ${words} words, the limit is ${limit}: split it`,
        span.text.slice(0, 100),
        span.start,
        words > DESCRIPTIVE_WORDS ? "error" : "warn",
      )
    }
    for (const hit of progressiveFindings(span)) {
      add(
        "ste-s16-progressive",
        hit.pattern === "P1"
          ? "do not use the progressive (be + -ing): write the simple present, 'is playing' -> 'plays' (STE 3.2)"
          : "do not open with an -ing clause: write 'If you use ...' or 'When you ...' (STE 3.5)",
        hit.snippet,
        hit.offset,
        "warn",
      )
    }
    const fragment = fragmentKind(span, role)
    if (fragment) {
      add(
        "ste-s18-fragment",
        fragment === "F1"
          ? "do not start a sentence with And, Or, But or So: join it to the sentence before or rewrite it"
          : "the sentence has no subject: write an imperative ('Read a file.') or name the subject ('The tool reads ...')",
        span.text.slice(0, 80),
        span.start,
        "error",
      )
    }
    if (badResultSentence(span, role)) {
      add(
        "ste-s21-result-verb",
        "write the result sentence as 'The tool gives ...' (DESIGN D5)",
        span.text.slice(0, 80),
        span.start,
        "error",
      )
    }
  }

  for (const hit of paragraphFindings(masked)) {
    add(
      "ste-s13-paragraph",
      `the paragraph has ${hit.count} sentences, the limit is ${PARAGRAPH_SENTENCES}: split it or make a list (STE 6.6)`,
      hit.snippet,
      hit.offset,
      "error",
    )
  }

  for (const hit of slashFindings(masked, text)) {
    add(
      "ste-s15-slash",
      "do not use a slash for 'or' or 'and': write 'x or y' (house rule)",
      hit.snippet,
      hit.offset,
      "error",
    )
  }

  if (ctx.termPairs !== false) {
    for (const hit of termPairFindings(masked)) add(...hit, 0, "warn")
  }

  if (ctx.extraFindings) {
    for (const finding of ctx.extraFindings({ masked, raw: text, lineOffset, file, role })) {
      findings.push({ ...finding, role: finding.role ?? role })
    }
  }

  // Severity by role: in the tool block every rule is an error (DESIGN D2).
  // In prose, the rules that land with recorded debt are a warning.
  for (const finding of findings) {
    // `could` stays a warning in every role (DESIGN 2, s17).
    if (finding.rule === "ste-s17-modal" && /^could$/i.test(finding.snippet)) continue
    if (role !== "prose") finding.severity = "error"
    else if (PROSE_WARN_RULES.has(finding.rule)) finding.severity = "warn"
  }

  return findings.sort((x, y) => x.line - y.line || x.rule.localeCompare(y.rule))
}

/**
 * s10: each pair of words for one meaning that both occur in the text.
 *
 * @param masked - Masked text. `reportByFile` passes every surface of a file.
 * @returns The rule, message and snippet of each pair.
 */
export function termPairFindings(masked: string): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = []
  for (const [a, b] of TERM_PAIRS) {
    const hasA = new RegExp(`\\b${a}\\b`, "i").test(masked)
    const hasB = new RegExp(`\\b${b}\\b`, "i").test(masked)
    if (hasA && hasB) {
      out.push([
        "ste-s10-inconsistent-term",
        `use one word for one meaning: "${a}" and "${b}" are both in this file`,
        `${a} / ${b}`,
      ])
    }
  }
  return out
}

/**
 * Count findings per rule id.
 *
 * @param findings - Findings for one file.
 * @returns A record of rule id to count.
 */
export function countByRule(findings: readonly SteFinding[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const finding of findings) out[finding.rule] = (out[finding.rule] ?? 0) + 1
  return out
}

/**
 * Count findings per rule id, and also the total.
 *
 * @param findings - Findings for one file.
 * @returns The per-rule counts and the total.
 */
export function summarize(findings: readonly SteFinding[]): {
  total: number
  errors: number
  warns: number
  byRule: Record<string, number>
} {
  return {
    total: findings.length,
    errors: findings.filter((f) => f.severity === "error").length,
    warns: findings.filter((f) => f.severity === "warn").length,
    byRule: countByRule(findings),
  }
}
