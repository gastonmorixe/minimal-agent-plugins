#!/usr/bin/env bun
/**
 * Calibrate the char-class token estimator weights for each tokenizer family.
 *
 * Inputs (all outside the repo; never commit them):
 *
 * - `--ref FILE`: JSONL, one record for each (family, chunk):
 *   `{ family, kind, text, tokens }`. `tokens` is the exact count of the
 *   public tokenizer of the family. The file is not in the repo (see
 *   "Reference corpus" in `ma-token-estimate-kit/README.md`). Without
 *   `--ref`, the script fits the session families from `--sessions` only.
 * - `--sessions DIR`: minimal-agent session JSONL files. The script makes
 *   samples from the input-token delta between two assistant turns:
 *   `delta(total input) - previous output_tokens`, over the tool-result
 *   text between them (more than 8000 chars, no user or note record between,
 *   no thinking in the previous turn). For `anthropic` (and imported Claude
 *   sessions with no provider) the total input is
 *   `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
 *   (the counters are disjoint). For all other providers `input_tokens`
 *   already includes the cached tokens.
 * - `--net-dbg DIR`: optional. Only prints the request-JSON bytes/token of
 *   Anthropic requests, for reference. The fit does not use it, because
 *   JSON escapes change the char mix.
 *
 * Other flags: `--max-session-samples N` (default 1500 for each family),
 * `--json FILE` (write the fitted params as JSON).
 *
 * The search: coordinate descent on the weights and the scale, to minimize
 * the mean absolute percentage error (MAPE) on 80% of the samples. The
 * script reports the MAPE on the other 20% (held out). For speed, it
 * computes the run-length histogram of each sample one time. At the end it
 * checks the histogram result against the REAL `makeCharClassEstimator`
 * from core, and reports the MAPE of the real estimator.
 *
 * Usage:
 * ```sh
 * bun run scripts/token-estimate-calibrate.ts --ref <ref.jsonl> [--sessions ~/.minimal-agent/sessions] [--net-dbg ~/.minimal-agent/net-dbg]
 * ```
 *
 * @module scripts/token-estimate-calibrate
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import {
  type CharClassEstimatorParams,
  makeCharClassEstimator,
  makeCharRatioEstimator,
} from "@minimal-agent/core/plugin-api/llm/token-estimate"

import { familyForModelId } from "../ma-token-estimate-kit/src/family.ts"

// --- args ---

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const ARGV = process.argv.slice(2)
const REF = argValue(ARGV, "--ref")
const SESSIONS = argValue(ARGV, "--sessions")
const NET_DBG = argValue(ARGV, "--net-dbg")
const JSON_OUT = argValue(ARGV, "--json")
const MAX_SESSION_SAMPLES = Number(argValue(ARGV, "--max-session-samples") ?? 1500)

// --- samples ---

type Sample = {
  family: string
  kind: string
  text: string
  tokens: number
  hist: Hist
  test: boolean
}

/** Ref-file family names that differ from the kit family names. */
const REF_FAMILY_RENAME: Record<string, string> = { llama: "llama3", grok2: "grok2" }

/** Old ratio of each family, for the "before" column. */
function oldRatio(family: string): number {
  if (family.startsWith("claude")) return 3.5
  if (family.startsWith("openai")) return 4
  if (family.startsWith("grok")) return 3.5
  return 3.8
}

// --- run histograms ---
//
// The class rules must give the same runs as core `makeCharClassEstimator`.
// The script checks this at the end against the real estimator.

const C_WORD = 0
const C_DIGIT = 1
const C_PUNCT = 2
const C_SPACE = 3
const C_CJK = 4
const C_OTHER = 5
const C_SCRIPT0 = 6

/** Extra scripts that the fit can weight. */
const SCRIPTS = [
  { name: "latinExt", from: 0x00c0, to: 0x024f },
  { name: "cyrillic", from: 0x0400, to: 0x04ff },
  { name: "arabic", from: 0x0600, to: 0x06ff },
] as const

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x2e80 && cp <= 0x2fdf) ||
    (cp >= 0x3000 && cp <= 0x30ff) ||
    (cp >= 0x3130 && cp <= 0x318f) ||
    (cp >= 0x31f0 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x3134f)
  )
}

/** Run histogram: parallel arrays of class, run length and count. */
type Hist = { cls: Int32Array; len: Int32Array; count: Int32Array }

/**
 * Histogram with the scripts on (`withScripts`) or off. A plain single
 * space run gives 0 tokens in core, so the histogram drops it.
 */
function histogram(text: string, withScripts: boolean): Hist {
  const map = new Map<number, number>()
  const add = (cls: number, len: number, plain: boolean): void => {
    if (cls < 0 || (cls === C_SPACE && plain)) return
    const key = cls * 1_000_000_000 + len
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  let runCls = -1
  let runLen = 0
  let plain = false
  const n = text.length
  for (let i = 0; i < n; i++) {
    let cp = text.charCodeAt(i)
    let cls: number
    if (cp < 0x80) {
      if ((cp >= 0x61 && cp <= 0x7a) || (cp >= 0x41 && cp <= 0x5a)) cls = C_WORD
      else if (cp >= 0x30 && cp <= 0x39) cls = C_DIGIT
      else if (cp === 0x20 || (cp >= 0x09 && cp <= 0x0d)) cls = C_SPACE
      else if (cp > 0x20 && cp < 0x7f) cls = C_PUNCT
      else cls = C_OTHER
    } else {
      if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < n) {
        const lo = text.charCodeAt(i + 1)
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00)
          i++
        }
      }
      if (isCjk(cp)) cls = C_CJK
      else {
        cls = C_OTHER
        if (withScripts) {
          for (let s = 0; s < SCRIPTS.length; s++) {
            const sc = SCRIPTS[s] as (typeof SCRIPTS)[number]
            if (cp >= sc.from && cp <= sc.to) {
              cls = C_SCRIPT0 + s
              break
            }
          }
        }
      }
    }
    if (cls === runCls) {
      runLen++
      plain = false
    } else {
      add(runCls, runLen, plain)
      runCls = cls
      runLen = 1
      plain = cp === 0x20
    }
  }
  add(runCls, runLen, plain)
  const size = map.size
  const h: Hist = {
    cls: new Int32Array(size),
    len: new Int32Array(size),
    count: new Int32Array(size),
  }
  let j = 0
  for (const [key, count] of map) {
    h.cls[j] = Math.floor(key / 1_000_000_000)
    h.len[j] = key % 1_000_000_000
    h.count[j] = count
    j++
  }
  return h
}

// --- params vector ---

/** Search vector: 6 weights, short-word max, scale, then the script weights. */
type Vec = number[]
const V_WORD = 0
const V_DIGIT = 1
const V_PUNCT = 2
const V_SPACE = 3
const V_CJK = 4
const V_OTHER = 5
const V_SHORT = 6
const V_SCALE = 7
const V_SCRIPT0 = 8

const BOUNDS: Array<[number, number]> = [
  [1.5, 24], // word
  [1, 4], // digit
  [0.5, 16], // punct
  [0.5, 200], // whitespace
  [0.3, 3], // cjk
  [0.2, 4], // other
  [0, 8], // short word max (integer)
  [0.5, 2], // scale
  ...SCRIPTS.map((): [number, number] => [0.3, 8]),
]

function vecToParams(v: Vec, withScripts: boolean): CharClassEstimatorParams {
  const r = (x: number): number => Math.round(x * 1000) / 1000
  const params: CharClassEstimatorParams = {
    wordCharsPerToken: r(v[V_WORD] as number),
    shortWordMaxChars: Math.round(v[V_SHORT] as number),
    digitCharsPerToken: r(v[V_DIGIT] as number),
    punctCharsPerToken: r(v[V_PUNCT] as number),
    whitespaceCharsPerToken: r(v[V_SPACE] as number),
    cjkCharsPerToken: r(v[V_CJK] as number),
    otherCharsPerToken: r(v[V_OTHER] as number),
    ...(withScripts
      ? {
          scripts: SCRIPTS.map((s, i) => ({
            from: s.from,
            to: s.to,
            charsPerToken: r(v[V_SCRIPT0 + i] as number),
          })),
        }
      : {}),
    ...(Math.abs((v[V_SCALE] as number) - 1) > 0.0005 ? { scale: r(v[V_SCALE] as number) } : {}),
  }
  return params
}

/** Estimate from the histogram. The same math as core, after `vecToParams` rounding. */
function histEstimate(h: Hist, p: CharClassEstimatorParams): number {
  const w = [
    p.wordCharsPerToken,
    p.digitCharsPerToken,
    p.punctCharsPerToken,
    p.whitespaceCharsPerToken,
    p.cjkCharsPerToken,
    p.otherCharsPerToken,
    ...(p.scripts ?? []).map((s) => s.charsPerToken),
  ]
  const shortMax = p.shortWordMaxChars
  let total = 0
  for (let j = 0; j < h.cls.length; j++) {
    const cls = h.cls[j] as number
    const len = h.len[j] as number
    const runTokens = cls === C_WORD && len <= shortMax ? 1 : Math.ceil(len / (w[cls] as number))
    total += runTokens * (h.count[j] as number)
  }
  return Math.ceil(total * (p.scale ?? 1))
}

/** Weighted MAPE in percent. */
function mape(
  samples: readonly Sample[],
  est: (s: Sample) => number,
  weight?: (s: Sample) => number,
): number {
  let sum = 0
  let wsum = 0
  for (const s of samples) {
    const w = weight ? weight(s) : 1
    sum += (w * Math.abs(est(s) - s.tokens)) / s.tokens
    wsum += w
  }
  return wsum === 0 ? Number.NaN : (100 * sum) / wsum
}

/** Coordinate descent with shrinking multiplicative steps. */
function fit(
  train: readonly Sample[],
  withScripts: boolean,
  fitScale: boolean,
  start: Vec,
  weight?: (s: Sample) => number,
  fixedNonAscii = false,
): Vec {
  const loss = (v: Vec): number => {
    const p = vecToParams(v, withScripts)
    return mape(train, (s) => histEstimate(s.hist, p), weight)
  }
  let best = [...start]
  let bestLoss = loss(best)
  const dims = fixedNonAscii
    ? [V_WORD, V_DIGIT, V_PUNCT, V_SPACE, V_SHORT]
    : [V_WORD, V_DIGIT, V_PUNCT, V_SPACE, V_CJK, V_OTHER, V_SHORT]
  if (fitScale) dims.push(V_SCALE)
  if (withScripts) for (let i = 0; i < SCRIPTS.length; i++) dims.push(V_SCRIPT0 + i)
  for (const step of [1.5, 1.2, 1.08, 1.03, 1.01]) {
    for (let round = 0; round < 40; round++) {
      let improved = false
      for (const d of dims) {
        const [lo, hi] = BOUNDS[d] as [number, number]
        const cur = best[d] as number
        const cands =
          d === V_SHORT
            ? [cur - 1, cur + 1]
            : [cur * step, cur / step, cur * step * step, cur / (step * step)]
        for (const c of cands) {
          if (c < lo || c > hi) continue
          const v = [...best]
          v[d] = c
          const l = loss(v)
          if (l < bestLoss - 1e-9) {
            best = v
            bestLoss = l
            improved = true
          }
        }
      }
      if (!improved) break
    }
  }
  return best
}

const START: Vec = [4.5, 3, 1.5, 6, 1, 1.5, 4, 1, 2.5, 2.5, 2.5]

// --- loaders ---

function loadRef(path: string): Sample[] {
  const out: Sample[] = []
  const indexByFamily = new Map<string, number>()
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    const r = JSON.parse(line) as { family: string; kind: string; text: string; tokens: number }
    if (!r.text || !(r.tokens > 0)) continue
    const family = REF_FAMILY_RENAME[r.family] ?? r.family
    const i = indexByFamily.get(family) ?? 0
    indexByFamily.set(family, i + 1)
    // The same chunk order in each family: the split is the same for all.
    out.push({
      family,
      kind: r.kind,
      text: r.text,
      tokens: r.tokens,
      hist: EMPTY,
      test: i % 5 === 0,
    })
  }
  return out
}

const EMPTY: Hist = { cls: new Int32Array(0), len: new Int32Array(0), count: new Int32Array(0) }

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** Read the first bytes of a file (the meta line). */
function head(path: string, bytes: number): string {
  const fd = openSync(path, "r")
  try {
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString("utf8")
  } finally {
    closeSync(fd)
  }
}

/** Session family: only the families with no public tokenizer data, and Claude. */
function sessionFamily(provider: string | undefined, model: string): string | undefined {
  const base = model.replace(/\[.*\]$/, "")
  if (provider === "cursor") return undefined // noisy usage
  if (base.startsWith("muse-")) return "meta-muse"
  if (provider === "grok" && base.startsWith("grok")) return "grok"
  if (base.startsWith("claude-") && (provider === "anthropic" || provider === undefined)) {
    return familyForModelId(base)
  }
  return undefined
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : JSON.stringify(b),
      )
      .join("\n")
  }
  return JSON.stringify(content ?? "")
}

function loadSessions(dir: string): Sample[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl") && f !== "index.jsonl")
    .sort()
  const counts = new Map<string, number>()
  const out: Sample[] = []
  for (const f of files) {
    const path = join(dir, f)
    let size: number
    try {
      size = statSync(path).size
    } catch {
      continue
    }
    if (size < 50_000 || size > 200_000_000) continue
    let meta: { provider?: string; model?: string }
    try {
      meta = JSON.parse(head(path, 4096).split("\n")[0] as string)
    } catch {
      continue
    }
    if (!meta.model) continue
    const family = sessionFamily(meta.provider, meta.model)
    if (!family || (counts.get(family) ?? 0) >= MAX_SESSION_SAMPLES) continue
    const disjoint = meta.provider === "anthropic" || meta.provider === undefined
    const total = (u: Usage): number =>
      (u.input_tokens ?? 0) +
      (disjoint ? (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0)
    let prev: { usage: Usage; think: boolean } | undefined
    let between: string[] = []
    let clean = true
    const heldOutFile = files.indexOf(f) % 5 === 0
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue
      let o: { kind?: string; usage?: Usage; content?: unknown }
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (o.kind === "assistant") {
        const u = o.usage
        if (!u) {
          prev = undefined
          between = []
          continue
        }
        const blocks = Array.isArray(o.content) ? (o.content as Array<{ type?: string }>) : []
        const think = blocks.some((b) => b?.type === "thinking" || b?.type === "redacted_thinking")
        if (prev && clean && !prev.think && between.length > 0) {
          const text = between.join("\n")
          const tokens = total(u) - total(prev.usage) - (prev.usage.output_tokens ?? 0)
          const ratio = tokens / text.length
          if (text.length > 8000 && ratio > 0.05 && ratio < 1.5) {
            const n = counts.get(family) ?? 0
            counts.set(family, n + 1)
            out.push({
              family,
              kind: "session",
              text,
              tokens,
              hist: EMPTY,
              test: heldOutFile,
            })
          }
        }
        prev = { usage: u, think }
        between = []
        clean = true
      } else if (o.kind === "tool_result") {
        between.push(toolResultText(o.content))
      } else if (
        o.kind === "user" ||
        o.kind === "note" ||
        o.kind === "compact" ||
        o.kind === "history_edit"
      ) {
        clean = false
      }
    }
  }
  return out
}

/** Reference only: request-JSON bytes for each input token, Anthropic. */
function netDbgBytesPerToken(dir: string): { n: number; median: number } {
  const ratios: number[] = []
  for (const d of readdirSync(dir).sort().reverse()) {
    const sub = join(dir, d)
    let names: string[]
    try {
      names = readdirSync(sub)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith("-02-req-body.txt")) continue
      const resPath = join(sub, name.replace("-02-req-body.txt", "-04-res-body.txt"))
      if (!existsSync(resPath)) continue
      const body = readFileSync(join(sub, name), "utf8")
      if (!body.startsWith('{"model":"claude-')) continue
      const m =
        /"usage":\{"input_tokens":(\d+),"cache_creation_input_tokens":(\d+),"cache_read_input_tokens":(\d+)/.exec(
          head(resPath, 8192),
        )
      if (!m) continue
      const tokens = Number(m[1]) + Number(m[2]) + Number(m[3])
      if (tokens > 1000) ratios.push(Buffer.byteLength(body) / tokens)
    }
    if (ratios.length >= 400) break
  }
  ratios.sort((a, b) => a - b)
  return { n: ratios.length, median: ratios[Math.floor(ratios.length / 2)] ?? Number.NaN }
}

// --- main ---

type Row = {
  family: string
  samples: number
  test: number
  before: number
  after: number
  real: number
  mismatches: number
  params: CharClassEstimatorParams
}

/**
 * Fit one family. `nonAscii` (for session data) fixes the CJK and other
 * weights to the given values and turns the scripts off: tool results have
 * too little non-ASCII text to fit them.
 */
function calibrate(
  family: string,
  all: readonly Sample[],
  weight?: (s: Sample) => number,
  nonAscii?: { cjk: number; other: number },
): Row {
  const withScripts = nonAscii === undefined
  for (const s of all) if (s.hist === EMPTY) s.hist = histogram(s.text, true)
  if (!withScripts) for (const s of all) s.hist = histogram(s.text, false)
  const train = all.filter((s) => !s.test)
  const test = all.filter((s) => s.test)
  // Multi-start: one start for each short-word max, then keep the best on the train set.
  let vec = START
  let vecLoss = Number.POSITIVE_INFINITY
  for (let short = 0; short <= 7; short++) {
    const start = [...START]
    start[V_SHORT] = short
    if (nonAscii) {
      start[V_CJK] = nonAscii.cjk
      start[V_OTHER] = nonAscii.other
    }
    const v = fit(train, withScripts, true, start, weight, nonAscii !== undefined)
    const p = vecToParams(v, withScripts)
    const l = mape(train, (s) => histEstimate(s.hist, p), weight)
    if (l < vecLoss) {
      vec = v
      vecLoss = l
    }
  }
  const params = vecToParams(vec, withScripts)
  const real = makeCharClassEstimator(params)
  const old = makeCharRatioEstimator(oldRatio(family))
  let mismatches = 0
  for (const s of test) if (real(s.text) !== histEstimate(s.hist, params)) mismatches++
  return {
    family,
    samples: all.length,
    test: test.length,
    before: mape(test, (s) => old(s.text), weight),
    after: mape(test, (s) => histEstimate(s.hist, params), weight),
    real: mape(test, (s) => real(s.text), weight),
    mismatches,
    params,
  }
}

function fmtParams(p: CharClassEstimatorParams): string {
  const parts = [
    `w=${p.wordCharsPerToken}`,
    `short=${p.shortWordMaxChars}`,
    `d=${p.digitCharsPerToken}`,
    `p=${p.punctCharsPerToken}`,
    `ws=${p.whitespaceCharsPerToken}`,
    `cjk=${p.cjkCharsPerToken}`,
    `o=${p.otherCharsPerToken}`,
  ]
  if (p.scripts) parts.push(`scripts=${p.scripts.map((s) => s.charsPerToken).join("/")}`)
  if (p.scale !== undefined) parts.push(`scale=${p.scale}`)
  return parts.join(" ")
}

function main(): void {
  if (!REF && !SESSIONS) {
    console.error(
      "usage: bun run scripts/token-estimate-calibrate.ts --ref FILE [--sessions DIR] [--net-dbg DIR]",
    )
    process.exit(2)
  }
  const t0 = performance.now()
  const samples: Sample[] = []
  if (REF) samples.push(...loadRef(REF))
  if (SESSIONS) samples.push(...loadSessions(SESSIONS))
  console.error(
    `loaded ${samples.length} samples in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
  )

  const byFamily = new Map<string, Sample[]>()
  for (const s of samples) {
    const list = byFamily.get(s.family) ?? []
    list.push(s)
    byFamily.set(s.family, list)
  }
  const rows: Row[] = []
  // generic: all ref families, each family with the same total weight.
  const refSamples = samples.filter((s) => s.kind !== "session")
  let nonAscii: { cjk: number; other: number } = { cjk: 1, other: 1 }
  if (refSamples.length > 0) {
    const famCount = new Map<string, number>()
    for (const s of refSamples) famCount.set(s.family, (famCount.get(s.family) ?? 0) + 1)
    const union = refSamples.map((s) => ({
      family: "generic",
      kind: s.kind,
      text: s.text,
      tokens: s.tokens,
      hist: EMPTY,
      test: s.test,
      src: s.family,
    }))
    const weight = (s: Sample): number =>
      1 / (famCount.get((s as Sample & { src: string }).src) ?? 1)
    const generic = calibrate("generic", union, weight)
    rows.push(generic)
    nonAscii = { cjk: generic.params.cjkCharsPerToken, other: generic.params.otherCharsPerToken }
  } else {
    console.error("no --ref: the session families use cjk=1 and other=1")
  }
  for (const [family, list] of [...byFamily].sort((a, b) => a[0].localeCompare(b[0]))) {
    const session = list.every((s) => s.kind === "session")
    rows.push(calibrate(family, list, undefined, session ? nonAscii : undefined))
    console.error(`fit ${family} (${((performance.now() - t0) / 1000).toFixed(1)}s)`)
  }

  console.log("| family | samples (held out) | MAPE before % | MAPE after % | params |")
  console.log("|---|---|---|---|---|")
  for (const r of rows) {
    console.log(
      `| ${r.family} | ${r.samples} (${r.test}) | ${r.before.toFixed(1)} | ${r.real.toFixed(1)} | ${fmtParams(r.params)} |`,
    )
  }
  const bad = rows.filter((r) => r.mismatches > 0)
  if (bad.length > 0) {
    console.error(
      `WARNING: histogram and core estimator differ: ${bad.map((r) => `${r.family}=${r.mismatches}`).join(", ")}`,
    )
  }
  if (NET_DBG) {
    const nd = netDbgBytesPerToken(NET_DBG)
    console.log(
      `\nnet-dbg Anthropic request JSON: ${nd.median.toFixed(2)} bytes/token (median, n=${nd.n}).`,
    )
  }
  if (JSON_OUT) {
    writeFileSync(
      JSON_OUT,
      `${JSON.stringify(
        rows.map(({ family, samples, test, before, real, params }) => ({
          family,
          samples,
          test,
          before,
          after: real,
          params,
        })),
        null,
        2,
      )}\n`,
    )
  }
}

main()
