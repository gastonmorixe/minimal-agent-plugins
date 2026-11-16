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
}

/** A rule pattern with its id, message and severity. */
interface WordRule {
  rule: string
  message: string
  pattern: RegExp
  severity: "error" | "warn"
}

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
    rule: "ste-s6-contraction",
    message: "do not use a contraction: write cannot, does not, it is",
    pattern:
      /\b(?:can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|it's|that's|let's|you'll|we'll|they're|you're)\b/gi,
    severity: "error",
  },
  {
    rule: "ste-s7-passive",
    message: "use the active voice when the agent is known",
    // `be` + a participle is passive. A regular participle ends in -ed. An
    // irregular one is in the list, and a participle can come straight after
    // the auxiliary, after `not`, or after one adverb (`also`, `only`, `still`).
    pattern:
      /\b(?:is|are|was|were|be|been|being)\s+(?:(?:not|also|only|still|already|then|now)\s+)?(?:\w+ed|done|made|sent|shown|given|taken|written|kept|held|built|read|withheld|hidden|known|chosen|cut|set|put|left|found|brought|thought|told|seen|heard|meant|spent|lost|won|paid|sold|drawn|grown|thrown|worn|torn|broken|spoken|frozen|driven|eaten|fallen|forgotten|gotten|born|laid|led|fled|fed|fought|sought|caught|taught|bound|wound|dug|hung|struck|stuck|stung|swum|sung|rung|drunk|shrunk|sunk|stolen|begun|become|come|gone)\b/gi,
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
const ALLOWED_NON_ASCII = new Set(["\u201c", "\u201d", "\u2018", "\u2019", "\u2191", "\u2193"])

/**
 * Report a character that is not on the allowlist.
 *
 * @param line - One line of raw text.
 * @returns Each disallowed character, with its code point.
 */
function hiddenCharacters(line: string): string[] {
  const out: string[] = []
  for (const char of line) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0x0a || code === 0x09) continue
    if (code >= 0x20 && code <= 0x7e) continue
    if (ALLOWED_NON_ASCII.has(char)) continue
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
      .replace(/\b[\w.-]+\/[\w./-]+\b/g, oneWord)
  )
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
    .replace(/\b[\w.-]+\/[\w./-]+\b/g, oneWord)
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

/** Split one line into sentences. Bullets and headings start a new sentence. */
function splitLine(line: string): string[] {
  const out: string[] = []
  const trimmed = line.replace(/^[ \t]*(?:[-*+]|\d+[.)]|#{1,6})\s*/, "")
  if (!trimmed.trim()) return out
  let buf = ""
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    buf += ch
    if (ch !== "." && ch !== "!" && ch !== "?") continue
    const next = trimmed[i + 1]
    const after = trimmed[i + 2]
    if (next === undefined || next === " ") {
      // An abbreviation or a version number does not end a sentence.
      if (/\b(?:e\.g|i\.e|etc|vs|cf|approx|No|Fig|L)\.$/i.test(buf)) continue
      if (next === " " && after !== undefined && !/[A-Z0-9"'([]/.test(after)) continue
      out.push(buf.trim())
      buf = ""
    }
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

/**
 * Split masked prose into sentences.
 *
 * @param text - Masked text.
 * @returns One entry for each sentence, in order.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = []
  for (const line of text.split("\n")) out.push(...splitLine(line))
  return out
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

/** True when the sentence reads as an instruction, not as a description. */
function isInstruction(sentence: string): boolean {
  // Case-insensitive: after a leading clause the verb can read lowercase.
  const first =
    /^(?:do|use|set|start|stop|read|write|call|make|keep|run|send|give|put|add|remove|check|examine|return|reply|continue|pause|ask|tell|show|open|close|never|always|if)\b/i
  if (first.test(sentence)) return true
  // An imperative behind a leading clause keeps the instruction limit:
  // "To show all tracked files, do not set `status`." is still an instruction.
  const leading = /^(?:When|While|If|To|For|After|Before|Unless|Because|Since)\b[^,]*,\s*/
  const rest = sentence.replace(leading, "")
  return rest !== sentence && first.test(rest)
}

/**
 * Apply every STE rule to one text.
 *
 * @param text - Raw text, before masking.
 * @param lineOffset - Shifts line numbers, for text inside a larger file.
 * @returns Every finding, in file order.
 */
export function lintText(text: string, lineOffset = 0): SteFinding[] {
  const offset = lineOffset
  const masked = maskNonProse(text)
  // Vocabulary rules read the words inside a code span too: real code does not
  // contain "utilize" or "moreover", so this cannot misfire, and it makes
  // hiding a banned word in a code-looking span impossible.
  const wordLines = maskForWords(text).split("\n")
  const lines = masked.split("\n")
  const findings: SteFinding[] = []

  lines.forEach((line, index) => {
    const lineNo = index + 1 + offset
    const wordLine = wordLines[index] ?? line
    for (const rule of WORD_RULES) {
      const vocabulary = VOCABULARY_RULES.has(rule.rule)
      const target = vocabulary ? wordLine : line
      rule.pattern.lastIndex = 0
      for (const match of target.matchAll(rule.pattern)) {
        if (rule.rule === "ste-s8-shout-case" && RULE_KEYWORD_LINE.test(line.trim())) continue
        findings.push({
          rule: rule.rule,
          message: rule.message,
          snippet: match[0],
          line: lineNo,
          severity: rule.severity,
        })
      }
    }
    if (line.includes(";")) {
      findings.push({
        rule: "ste-s2-semicolon",
        message: "write two sentences instead of a semicolon",
        snippet: line.trim().slice(0, 80),
        line: lineNo,
        severity: "error",
      })
    }
    const hidden = hiddenCharacters(line)
    if (hidden.length > 0) {
      const points = hidden.map(
        (c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
      )
      findings.push({
        rule: "ste-s12-hidden-char",
        message:
          "character is not on the allowlist: add it here with a reason if it is intentional",
        snippet: `${points.join(" ")} ${hidden.join("")}`,
        line: lineNo,
        severity: "error",
      })
    }
    const typographic = line.match(/[\u2014\u2013\u201c\u201d\u2018\u2019\u2026\u2192]/g)
    if (typographic) {
      findings.push({
        rule: "ste-s3-typographic",
        message: "use plain ASCII punctuation",
        snippet: typographic.join(""),
        line: lineNo,
        severity: "error",
      })
    }
  })

  // Classify on the raw text. Masking turns `To` and `If` into a placeholder,
  // so a leading clause would never match on the masked line.
  const rawSentences = splitSentences(text)
  const maskedSentences = splitSentences(masked)
  for (const [index, sentence] of maskedSentences.entries()) {
    const words = wordCount(sentence)
    const raw = rawSentences[index] ?? sentence
    const limit = isInstruction(raw) ? INSTRUCTION_WORDS : DESCRIPTIVE_WORDS
    if (words <= limit) continue
    findings.push({
      rule: "ste-s1-long-sentence",
      message: `sentence has ${words} words, the limit is ${limit}: split it`,
      snippet: sentence.slice(0, 100),
      line: lineNumberIn(masked, sentence) + offset,
      severity: words > DESCRIPTIVE_WORDS ? "error" : "warn",
    })
  }

  for (const [a, b] of TERM_PAIRS) {
    const hasA = new RegExp(`\\b${a}\\b`, "i").test(masked)
    const hasB = new RegExp(`\\b${b}\\b`, "i").test(masked)
    if (hasA && hasB) {
      findings.push({
        rule: "ste-s10-inconsistent-term",
        message: `use one word for one meaning: "${a}" and "${b}" are both in this file`,
        snippet: `${a} / ${b}`,
        line: 1,
        severity: "warn",
      })
    }
  }

  return findings.sort((x, y) => x.line - y.line || x.rule.localeCompare(y.rule))
}

/** The 1-based line of the first occurrence of `sentence` in `text`. */
function lineNumberIn(text: string, sentence: string): number {
  const index = text.indexOf(sentence)
  if (index < 0) return 1
  return text.slice(0, index).split("\n").length
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
