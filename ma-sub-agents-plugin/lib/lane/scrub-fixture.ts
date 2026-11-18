/**
 * Scrub a real worker session into a lane replay fixture (lane plan H5).
 *
 * A fixture is three files in `lib/__fixtures__/lane/`:
 *
 *  - `<name>.stream.ndjson`: the worker's stream-json stdout (`<sid>.stream.ndjson`),
 *  - `<name>.jsonl`: the worker's session transcript (`<sid>.jsonl`),
 *  - `<name>.fleet.jsonl`: the worker's last fleet record, one line, as the
 *    plugin writes it in `<leadSid>.subagents.jsonl` (`store.ts`).
 *
 * The scrub works on the parsed JSON values, so every output line stays valid
 * JSON. It replaces home paths, the user name, the host name, emails, keys,
 * tokens, cookies and long hex or base64 runs with placeholders, and maps each
 * UUID to a short placeholder that keeps only its first 8 characters. Strings
 * longer than the clip limit are cut with a visible marker. When the pair is
 * still too large, the scrub keeps the first lines at a line boundary and
 * reports the cut.
 *
 * Pure parts ({@link scrubString}, {@link scrubValue}, {@link scrubJsonLine},
 * {@link findLeaks}) have no IO. {@link scrubSession} reads the sessions
 * directory (read only) and writes the fixture files.
 *
 * Usage: `bun ma-sub-agents-plugin/lib/lane/scrub-fixture.ts <sidPrefix> <name> [names...]`
 *
 * @module sub-agents/lib/lane/scrub-fixture
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, hostname, userInfo } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

import { defaultSessionsDir, parseRecords } from "../store.ts"

/** The placeholder for every home directory. */
export const HOME_PLACEHOLDER = "/home/user"

/** Strings longer than this many characters are clipped. */
export const DEFAULT_CLIP_CHARS = 4000

/** The largest stream plus transcript size of one fixture, in bytes. */
export const DEFAULT_MAX_PAIR_BYTES = 150_000

/** The share of {@link DEFAULT_MAX_PAIR_BYTES} that the stream can use. */
const STREAM_SHARE = 0.6

/** Placeholder rules, applied in order to every string (values and keys). */
const RULES: readonly (readonly [RegExp, string | ((m: string) => string)])[] = [
  // Private keys first: they span many lines.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private-key]"],
  // Home and per-user temp paths.
  [/\/Users\/[^/\s"'`]+/g, HOME_PLACEHOLDER],
  [/\/home\/(?!user(?![^/\s"'`]))[^/\s"'`]+/g, HOME_PLACEHOLDER],
  [/(?:\/private)?\/var\/folders\/[^/\s"'`]+\/[^/\s"'`]+\/[A-Z]\//g, "/tmp/"],
  [/[A-Za-z]:\\Users\\[^\\\s"'`]+/g, HOME_PLACEHOLDER],
  // Emails, before the user name rule, so `name@host` is one placeholder.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[email]"],
  // Auth headers and secret-looking assignments.
  [/\bBearer\s+[^\s"'`]*/gi, "[auth]"],
  [/\bBasic\s+[A-Za-z0-9+/=]{12,}/g, "[auth]"],
  [
    /\b(authorization|x-api-key|api[-_]?key|apikey|set-cookie|cookie|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|client[-_]?secret)(["']?\s*[:=]\s*["']?)([^\s"'`,;}]{6,})/gi,
    (m) => m.replace(/([:=]\s*["']?)[^\s"'`,;}]+$/, "$1[redacted]"),
  ],
  // Provider key shapes.
  [/\bsk-[A-Za-z0-9_-]*/g, "[secret]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "[secret]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[secret]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[secret]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[secret]"],
  [/\bAIza[0-9A-Za-z_-]{35}/g, "[secret]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[jwt]"],
  // The literal key name (the check test forbids it).
  [/api_key/gi, "api-key"],
  // Long hex (hashes, ids) and long base64-looking runs.
  [/\b[0-9a-f]{32,}\b/gi, "[hex]"],
  [
    /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{40,}(?![A-Za-z0-9+/_=-])/g,
    (m) => (isSecretLike(m) ? "[b64]" : m),
  ],
]

/** True when a long run has the mix of a random token, not of a path or a name. */
function isSecretLike(run: string): boolean {
  const upper = run.replace(/[^A-Z]/g, "").length
  const digits = run.replace(/[^0-9]/g, "").length
  // A path or a kebab name has short segments; a token has one long segment.
  const longest = Math.max(...run.split(/[/_-]/).map((p) => p.length))
  return longest >= 24 && upper >= 4 && digits >= 4 && /[a-z]/.test(run)
}

/** UUIDs become `<first 8>-0000-4000-8000-000000000000`. */
const UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

/** Options of the pure scrub. */
export interface ScrubOptions {
  /** Clip strings longer than this (characters). `0` disables the clip. */
  readonly clipChars?: number
  /** More literal words to replace with `host` (the machine name). */
  readonly hostNames?: readonly string[]
  /** User names: each word that contains one becomes `user`. */
  readonly userNames?: readonly string[]
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Scrub one string: placeholders for paths, names and secrets, then the clip. */
export function scrubString(s: string, opts: ScrubOptions = {}): string {
  let out = s.replace(
    UUID,
    (_m, head: string) => `${head.toLowerCase()}-0000-4000-8000-000000000000`,
  )
  for (const [re, to] of RULES) {
    out = typeof to === "string" ? out.replace(re, to) : out.replace(re, to)
  }
  for (const h of opts.hostNames ?? []) {
    if (h.length >= 3) out = out.replace(new RegExp(escapeRegExp(h), "gi"), "host")
  }
  // The user name, wherever the path rules did not catch it. The whole word
  // goes, so a handle such as `<name>dev` leaves no part of the name.
  for (const u of opts.userNames ?? []) {
    if (u.length >= 3)
      out = out.replace(new RegExp(`[A-Za-z0-9]*${escapeRegExp(u)}[A-Za-z0-9]*`, "gi"), "user")
  }
  const clip = opts.clipChars ?? DEFAULT_CLIP_CHARS
  if (clip > 0 && out.length > clip) {
    out = `${out.slice(0, clip)}…[clipped ${out.length - clip} chars]`
  }
  return out
}

/** Scrub every string and every key of a parsed JSON value. */
export function scrubValue(v: unknown, opts: ScrubOptions = {}): unknown {
  if (typeof v === "string") return scrubString(v, opts)
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, opts))
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      out[scrubString(k, { ...opts, clipChars: 0 })] = scrubValue(x, opts)
    }
    return out
  }
  return v
}

/** Scrub one JSON line. A line that is not JSON is dropped (`undefined`). */
export function scrubJsonLine(line: string, opts: ScrubOptions = {}): string | undefined {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return undefined
  }
  return JSON.stringify(scrubValue(obj, opts))
}

/** One leak that {@link findLeaks} found: the rule name and the line number. */
export interface Leak {
  readonly rule: string
  readonly line: number
}

/** The rules of the fixture check. Each must find nothing in a fixture. */
export const LEAK_RULES: readonly (readonly [string, RegExp])[] = [
  ["home path /Users/", /\/Users\//],
  ["sk- key", /(?:^|[^A-Za-z0-9])sk-/],
  ["bearer", /bearer\s/i],
  ["api_key", /api_key/i],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ["private key", /PRIVATE KEY-----/],
  ["github token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_/],
  ["aws key", /\bAKIA[0-9A-Z]{16}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./],
  ["long hex", /\b[0-9a-f]{32,}\b/i],
]

/** Find leaks in a text. Gives the rule names and line numbers, never the text. */
export function findLeaks(text: string): Leak[] {
  const out: Leak[] = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    for (const [rule, re] of LEAK_RULES) {
      if (re.test(lines[i] ?? "")) out.push({ rule, line: i + 1 })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

/** What {@link scrubSession} wrote. Sizes in bytes. */
export interface ScrubReport {
  readonly name: string
  readonly sidPrefix: string
  readonly status: string
  readonly streamBytes: number
  readonly transcriptBytes: number
  readonly fleetBytes: number
  readonly streamLines: number
  readonly streamLinesTotal: number
  readonly transcriptLines: number
  readonly transcriptLinesTotal: number
  readonly truncated: boolean
  readonly clippedStrings: number
}

/** Options of {@link scrubSession}. */
export interface ScrubSessionOptions {
  readonly sessionsDir?: string
  readonly outDir?: string
  readonly clipChars?: number
  readonly maxPairBytes?: number
  /** More user names to scrub (for example a family name in a repo URL). */
  readonly userNames?: readonly string[]
}

/** The fixture directory next to this module. */
export const LANE_FIXTURES_OUT_DIR = fileURLToPath(
  new URL("../__fixtures__/lane/", import.meta.url),
)

function readLines(path: string): string[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
}

/** Keep the first lines while their size (with `\n`) stays within `budget`. */
function keepWithin(lines: readonly string[], budget: number): string[] {
  const out: string[] = []
  let size = 0
  for (const l of lines) {
    const n = Buffer.byteLength(l, "utf-8") + 1
    if (size + n > budget) break
    out.push(l)
    size += n
  }
  return out
}

function bytesOf(lines: readonly string[]): number {
  return lines.reduce((a, l) => a + Buffer.byteLength(l, "utf-8") + 1, 0)
}

/**
 * Scrub one real worker session (found by its sid prefix) into a fixture.
 * Reads the sessions directory only; writes the three fixture files.
 */
export function scrubSession(
  sidPrefix: string,
  name: string,
  opts: ScrubSessionOptions = {},
): ScrubReport {
  const dir = opts.sessionsDir ?? defaultSessionsDir()
  const outDir = opts.outDir ?? LANE_FIXTURES_OUT_DIR
  const clipChars = opts.clipChars ?? DEFAULT_CLIP_CHARS
  const maxPair = opts.maxPairBytes ?? DEFAULT_MAX_PAIR_BYTES
  const streamFile = readdirSync(dir).find(
    (f) => f.startsWith(sidPrefix) && f.endsWith(".stream.ndjson"),
  )
  if (!streamFile) throw new Error(`no stream file for ${sidPrefix}`)
  const sid = streamFile.slice(0, -".stream.ndjson".length)

  let record: unknown
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".subagents.jsonl")) continue
    for (const r of parseRecords(readFileSync(join(dir, f), "utf-8"))) {
      if (r.sid === sid) record = r
    }
  }
  if (!record) throw new Error(`no fleet record for ${sidPrefix}`)

  const sopts: ScrubOptions = {
    clipChars,
    hostNames: [hostname(), hostname().split(".")[0] ?? ""],
    userNames: [userInfo().username, basename(homedir()), ...(opts.userNames ?? [])],
  }
  let clipped = 0
  const scrubAll = (lines: readonly string[]): string[] =>
    lines.flatMap((l) => {
      const s = scrubJsonLine(l, sopts)
      if (s === undefined) return []
      clipped += (s.match(/…\[clipped \d+ chars\]/g) ?? []).length
      return [s]
    })

  const streamAll = scrubAll(readLines(join(dir, streamFile)))
  const transcriptPath = join(dir, `${sid}.jsonl`)
  const transcriptAll = existsSync(transcriptPath) ? scrubAll(readLines(transcriptPath)) : []
  const stream = keepWithin(streamAll, Math.floor(maxPair * STREAM_SHARE))
  const transcript = keepWithin(transcriptAll, maxPair - bytesOf(stream))
  const fleetLine = JSON.stringify(scrubValue(record, sopts))

  const write = (file: string, lines: readonly string[]) =>
    writeFileSync(join(outDir, file), lines.length ? `${lines.join("\n")}\n` : "")
  write(`${name}.stream.ndjson`, stream)
  write(`${name}.jsonl`, transcript)
  write(`${name}.fleet.jsonl`, [fleetLine])

  return {
    name,
    sidPrefix: sid.slice(0, 8),
    status: (record as { status?: { kind?: string } }).status?.kind ?? "?",
    streamBytes: bytesOf(stream),
    transcriptBytes: bytesOf(transcript),
    fleetBytes: Buffer.byteLength(fleetLine, "utf-8") + 1,
    streamLines: stream.length,
    streamLinesTotal: streamAll.length,
    transcriptLines: transcript.length,
    transcriptLinesTotal: transcriptAll.length,
    truncated: stream.length < streamAll.length || transcript.length < transcriptAll.length,
    clippedStrings: clipped,
  }
}

if (import.meta.main) {
  const [sidPrefix, name, ...userNames] = process.argv.slice(2)
  if (!sidPrefix || !name) {
    process.stderr.write("usage: bun scrub-fixture.ts <sidPrefix> <name> [moreUserNames...]\n")
    process.exit(2)
  }
  process.stdout.write(`${JSON.stringify(scrubSession(sidPrefix, name, { userNames }))}\n`)
}
