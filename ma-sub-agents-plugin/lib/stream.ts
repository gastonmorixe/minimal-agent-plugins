/**
 * Live worker telemetry from the child's `--output-format stream-json` stdout.
 *
 * Every worker runs with `--output-format stream-json`, and its stdout goes to
 * `<sid>.stream.ndjson`. That file is a typed event protocol, not a log:
 * `session_started` → (`turn_started` · `item_*` · `text_delta` ·
 * `tool_result` · `turn_completed`)* → `run_finished` → `result`. Each line
 * carries `seq` and `ts` (epoch ms). Reading it gives the supervisor:
 *
 *  - the RESOLVED model / provider (the plan may leave `--model` empty),
 *  - per-turn usage straight from `turn_completed` (no transcript re-parse),
 *  - the tool in flight right now (an `item_started` with no `tool_result` yet),
 *    tool error counts and wall time,
 *  - the live text tail from `text_delta` while the model writes,
 *  - a definite end of run (`run_finished.outcome`) and the final answer
 *    (`result.text`, `durationMs`, summed usage),
 *  - the real cause of a failure (`error.message` / `hint`), including boot
 *    failures: the CLI ends stdout with `error` + `run_finished(failed)` even
 *    when the session never opened.
 *
 * Pure: {@link createStreamState} + {@link feedStream} fold text into a
 * {@link StreamState}. {@link streamReader} is the only IO: it reads ONLY the
 * bytes appended since the last tick, so a long worker costs O(new bytes) per
 * second, not O(file).
 *
 * The plugin imports no host types (the decoupling contract), so the wire
 * shapes are re-declared here as tolerant `Maybe*` views.
 *
 * @module sub-agents/lib/stream
 */

import { closeSync, openSync, readSync, statSync } from "node:fs"

import { type ErrorFacts, errorEventText, readErrorFacts } from "./error-text.ts"
import type { Progress } from "./types.ts"

/** One line of the activity ring that `AgentOutput` renders. */
export interface StreamActivity {
  /** Epoch ms of the event. */
  readonly ts: number
  readonly kind: "tool" | "tool_error" | "text" | "notice" | "error"
  readonly text: string
}

/** What the worker is doing at this instant. */
export type StreamPhase = "starting" | "thinking" | "writing" | "tool" | "waiting" | "finished"

/** The tool call that has started and not yet returned. */
export interface InFlightTool {
  readonly id: string
  readonly name: string
  /** `Bash: bun test`, `Read: src/x.ts`. */
  readonly label: string
  /** Epoch ms the call started. */
  readonly since: number
}

/** The final `result` line of the run. */
export interface StreamResult {
  readonly text: string
  readonly outcome: string
  readonly stopReason: string | null
  readonly durationMs: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** A failure the stream reported. */
export interface StreamError {
  /** The text of the error. Never "" (a CoreError event gets its kind text). */
  readonly message: string
  readonly code?: string
  readonly hint?: string
  /** The typed facts of a CoreError event (`error: {kind, fields}`), when present. */
  readonly error?: ErrorFacts
}

/** Everything derived from a worker's event stream so far. Mutable accumulator. */
export interface StreamState {
  /** Lines parsed (complete JSON lines only). */
  lines: number
  model?: string
  provider?: string
  effort?: string
  /** Epoch ms of `session_started` (or the first line seen). */
  startedAt?: number
  /** Epoch ms of the newest event. Drives the "idle Ns" hint. */
  lastEventAt?: number
  /** The newest `turn_started.turn`. */
  turns: number
  tools: number
  toolErrors: number
  /** Summed tool wall time, ms. */
  toolMs: number
  /** Last turn context: input + cacheRead + cacheCreation. */
  contextTokens: number
  /** Output tokens summed over turns. */
  outputTokens: number
  /** Reasoning tokens summed over turns (absent until a turn reports any). */
  thinkingTokens?: number
  phase: StreamPhase
  /** Newest still-active in-flight tool call, or `undefined` when idle. */
  inFlight?: InFlightTool
  /** Count of currently in-flight tool calls. */
  inFlightCount: number
  /** Active in-flight tool calls keyed by call id (insertion order). */
  inFlightTools: Map<string, InFlightTool>
  lastTool?: string
  /** A one-line digest of the newest activity. */
  lastActivity?: string
  /** Tail of the text block being streamed right now (from `text_delta`). */
  liveText: string
  /** The text items of the newest model response (reset per turn). */
  turnTexts: string[]
  /** The newest non-empty assistant response text (the distill fallback). */
  lastResponseText?: string
  lastNotice?: string
  error?: StreamError
  /** `run_finished.outcome`. */
  outcome?: string
  result?: StreamResult
  /** Recent activity, newest last, bounded by {@link ACTIVITY_CAP}. */
  activity: StreamActivity[]
}

/** How many activity lines the ring keeps. */
export const ACTIVITY_CAP = 40
/** How much live text (chars) the state keeps. */
const LIVE_TEXT_CAP = 240

interface WaveTracker {
  baseToolMs: number
  intervals: Array<[number, number]>
}

const waveTrackers = new WeakMap<StreamState, WaveTracker>()

function waveTrackerFor(s: StreamState): WaveTracker {
  let tracker = waveTrackers.get(s)
  if (!tracker) {
    tracker = { baseToolMs: s.toolMs, intervals: [] }
    waveTrackers.set(s, tracker)
  }
  return tracker
}

function mergedIntervalMs(intervals: readonly [number, number][]): number {
  if (intervals.length === 0) return 0
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let total = 0
  let curStart = sorted[0]![0]
  let curEnd = sorted[0]![1]
  for (let i = 1; i < sorted.length; i++) {
    const [start, end] = sorted[i]!
    if (start <= curEnd) {
      if (end > curEnd) curEnd = end
    } else {
      total += curEnd - curStart
      curStart = start
      curEnd = end
    }
  }
  return total + (curEnd - curStart)
}

function syncInFlightSummary(s: StreamState): void {
  s.inFlightCount = s.inFlightTools.size
  let newest: InFlightTool | undefined
  for (const tool of s.inFlightTools.values()) newest = tool
  s.inFlight = newest
}

function clearInFlight(s: StreamState): void {
  const tracker = waveTrackers.get(s)
  if (tracker) {
    tracker.baseToolMs = s.toolMs
    tracker.intervals = []
  }
  s.inFlightTools.clear()
  s.inFlight = undefined
  s.inFlightCount = 0
}

/** A fresh, empty state. */
export function createStreamState(): StreamState {
  return {
    lines: 0,
    turns: 0,
    tools: 0,
    toolErrors: 0,
    toolMs: 0,
    contextTokens: 0,
    outputTokens: 0,
    phase: "starting",
    inFlightCount: 0,
    inFlightTools: new Map(),
    liveText: "",
    turnTexts: [],
    activity: [],
  }
}

// ---------------------------------------------------------------------------
// Wire views (tolerant: every field optional)
// ---------------------------------------------------------------------------

interface MaybeUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

interface MaybeLine {
  type?: string
  ts?: number
  // session_started
  model?: string
  provider?: string | null
  effort?: string | null
  // turn_*
  turn?: number
  usage?: MaybeUsage
  stopReason?: string | null
  // item_* / tool_result
  itemType?: string
  id?: string
  toolName?: string
  name?: string
  input?: Record<string, unknown>
  text?: string
  isError?: boolean
  outputSummary?: string
  durationMs?: number
  // notice / error / run_finished / result
  notice?: { kind?: string; message?: string; severity?: string }
  message?: string
  code?: string
  hint?: string
  /** A CoreError event: message "" and `{kind, fields}`. */
  error?: unknown
  outcome?: string
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

function oneLine(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}

/** `Bash: bun test`, from a tool name and its input. */
export function toolLabel(name: string, input: Record<string, unknown> | undefined): string {
  const o = input ?? {}
  const arg =
    (typeof o.command === "string" && o.command) ||
    (typeof o.file_path === "string" && o.file_path) ||
    (typeof o.path === "string" && o.path) ||
    (typeof o.pattern === "string" && o.pattern) ||
    (typeof o.query === "string" && o.query) ||
    (typeof o.url === "string" && o.url) ||
    (typeof o.description === "string" && o.description) ||
    ""
  const a = oneLine(arg, 120)
  return a ? `${name}: ${a}` : name
}

function pushActivity(s: StreamState, a: StreamActivity): void {
  s.activity.push(a)
  if (s.activity.length > ACTIVITY_CAP) s.activity.splice(0, s.activity.length - ACTIVITY_CAP)
}

/** Fold one parsed stream line into `s`. Unknown types are ignored. */
export function applyStreamLine(s: StreamState, e: MaybeLine): void {
  const ts = typeof e.ts === "number" ? e.ts : s.lastEventAt
  if (ts !== undefined) {
    s.lastEventAt = ts
    if (s.startedAt === undefined) s.startedAt = ts
  }
  const at = ts ?? 0
  switch (e.type) {
    case "session_started":
      if (typeof e.model === "string" && e.model) s.model = e.model
      if (typeof e.provider === "string" && e.provider) s.provider = e.provider
      if (typeof e.effort === "string" && e.effort) s.effort = e.effort
      if (ts !== undefined) s.startedAt = ts
      break
    case "turn_started":
      s.turns = Math.max(s.turns, num(e.turn))
      s.turnTexts = []
      s.liveText = ""
      s.phase = "waiting"
      break
    case "block_started":
      s.liveText = ""
      s.phase = e.itemType === "thinking" ? "thinking" : "writing"
      break
    case "thinking_delta":
      s.phase = "thinking"
      break
    case "text_delta":
      if (typeof e.text === "string") {
        s.phase = "writing"
        const t = s.liveText + e.text
        s.liveText = t.length > LIVE_TEXT_CAP ? t.slice(-LIVE_TEXT_CAP) : t
        const live = oneLine(s.liveText, 200)
        if (live) s.lastActivity = live
      }
      break
    case "item_started":
      if (e.itemType === "tool_use") {
        const name = e.toolName ?? e.name ?? "tool"
        const label = toolLabel(name, e.input)
        const id = e.id ?? `__anon_${s.tools}`
        s.tools++
        s.lastTool = name
        s.lastActivity = label
        s.phase = "tool"
        if (s.inFlightTools.size === 0) {
          const tracker = waveTrackerFor(s)
          tracker.baseToolMs = s.toolMs
          tracker.intervals = []
        }
        s.inFlightTools.set(id, { id: e.id ?? "", name, label, since: at })
        syncInFlightSummary(s)
        pushActivity(s, { ts: at, kind: "tool", text: label })
      }
      break
    case "item_completed":
      if (e.itemType === "text" && typeof e.text === "string") {
        s.turnTexts.push(e.text)
        const whole = s.turnTexts.join("").trim()
        if (whole) s.lastResponseText = whole
        const t = oneLine(e.text, 200)
        if (t) {
          s.lastActivity = t
          pushActivity(s, { ts: at, kind: "text", text: t })
        }
        s.liveText = ""
      }
      break
    case "tool_result": {
      const dur = num(e.durationMs)
      if (e.isError === true) {
        s.toolErrors++
        const what = `${e.name ?? "tool"} failed${e.outputSummary ? `: ${oneLine(e.outputSummary, 140)}` : ""}`
        pushActivity(s, { ts: at, kind: "tool_error", text: what })
      }
      let finished: InFlightTool | undefined
      if (e.id !== undefined && s.inFlightTools.has(e.id)) {
        finished = s.inFlightTools.get(e.id)
        s.inFlightTools.delete(e.id)
      } else if (e.id === undefined && s.inFlightTools.size > 0) {
        const firstKey = s.inFlightTools.keys().next().value
        if (firstKey !== undefined) {
          finished = s.inFlightTools.get(firstKey)
          s.inFlightTools.delete(firstKey)
        }
      }
      const tracker = waveTrackerFor(s)
      if (finished && finished.since > 0 && at >= finished.since && dur > 0) {
        tracker.intervals.push([finished.since, Math.max(finished.since + dur, at)])
        s.toolMs = tracker.baseToolMs + mergedIntervalMs(tracker.intervals)
      } else {
        s.toolMs += dur
        tracker.baseToolMs = s.toolMs
      }
      syncInFlightSummary(s)
      s.phase = s.inFlightTools.size > 0 ? "tool" : "waiting"
      break
    }
    case "turn_completed": {
      const u = e.usage ?? {}
      s.contextTokens = num(u.inputTokens) + num(u.cacheReadTokens) + num(u.cacheCreationTokens)
      s.outputTokens += num(u.outputTokens)
      if (typeof u.reasoningTokens === "number") {
        s.thinkingTokens = (s.thinkingTokens ?? 0) + u.reasoningTokens
      }
      clearInFlight(s)
      s.phase = "waiting"
      break
    }
    case "notice": {
      const msg = e.notice?.message ?? e.notice?.kind
      if (typeof msg === "string" && msg) {
        s.lastNotice = oneLine(msg, 160)
        pushActivity(s, { ts: at, kind: "notice", text: s.lastNotice })
      }
      break
    }
    case "error": {
      const facts = readErrorFacts(e.error)
      const message = errorEventText(e.message, facts)
      s.error = {
        message,
        ...(typeof e.code === "string" ? { code: e.code } : {}),
        ...(typeof e.hint === "string" ? { hint: e.hint } : {}),
        ...(facts ? { error: facts } : {}),
      }
      pushActivity(s, { ts: at, kind: "error", text: oneLine(message, 200) })
      break
    }
    case "run_finished":
      if (typeof e.outcome === "string") s.outcome = e.outcome
      s.phase = "finished"
      clearInFlight(s)
      break
    case "result": {
      const u = e.usage ?? {}
      const outcome = typeof e.outcome === "string" ? e.outcome : (s.outcome ?? "failed")
      s.result = {
        text: typeof e.text === "string" ? e.text : "",
        outcome,
        stopReason: typeof e.stopReason === "string" ? e.stopReason : null,
        durationMs: num(e.durationMs),
        inputTokens: num(u.inputTokens),
        outputTokens: num(u.outputTokens),
        cacheReadTokens: num(u.cacheReadTokens),
        cacheWriteTokens: num(u.cacheWriteTokens),
      }
      if (s.outcome === undefined) s.outcome = outcome
      s.phase = "finished"
      clearInFlight(s)
      break
    }
    default:
      break
  }
}

/**
 * Feed a chunk of stream text into `s`. Returns the trailing partial line
 * (no `\n` yet) for the caller to prepend to the next chunk. Corrupt lines
 * are skipped.
 */
export function feedStream(s: StreamState, chunk: string): string {
  const parts = chunk.split("\n")
  const rest = parts.pop() ?? ""
  for (const raw of parts) {
    const line = raw.trim()
    if (line.length === 0 || line[0] !== "{") continue
    let obj: MaybeLine
    try {
      obj = JSON.parse(line) as MaybeLine
    } catch {
      continue
    }
    s.lines++
    applyStreamLine(s, obj)
  }
  return rest
}

/** Parse a whole stream text at once (tests, one-shot reads). */
export function parseStream(text: string): StreamState {
  const s = createStreamState()
  const rest = feedStream(s, text)
  if (rest.trim()) feedStream(s, `${rest}\n`)
  return s
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

/**
 * True once the stream proved stdout is complete: the final `result` line of
 * a normal run, or a failed/aborted `run_finished` (a host-side failure writes
 * no `result`). A completed `run_finished` alone is not enough: a schema
 * retry can start another turn after it.
 */
export function streamEnded(s: StreamState): boolean {
  if (s.result !== undefined) return true
  return (
    s.outcome === "failed" ||
    s.outcome === "aborted" ||
    (s.outcome === "waiting" && s.error !== undefined)
  )
}

/**
 * The {@link Progress} the fleet stores, from the stream. `undefined` when the
 * stream holds nothing yet (so the transcript fallback can still answer).
 */
export function streamProgress(s: StreamState): Progress | undefined {
  if (s.lines === 0) return undefined
  const activity =
    s.phase === "tool" && s.inFlight
      ? s.inFlight.label
      : s.phase === "thinking"
        ? "thinking…"
        : s.lastActivity
  return {
    tools: s.tools,
    tokens: s.contextTokens,
    ...(s.outputTokens > 0 ? { output: s.outputTokens } : {}),
    ...(s.thinkingTokens !== undefined ? { thinking: s.thinkingTokens } : {}),
    ...(s.lastTool ? { lastTool: s.lastTool } : {}),
    ...(activity ? { lastActivity: activity } : {}),
    turns: s.turns,
    ...(s.toolErrors > 0 ? { toolErrors: s.toolErrors } : {}),
    phase: s.phase,
    ...(s.inFlight ? { toolSince: s.inFlight.since } : {}),
    ...(s.lastEventAt !== undefined ? { lastEventAt: s.lastEventAt } : {}),
    ...(s.model ? { model: s.model } : {}),
    ...(s.effort ? { effort: s.effort } : {}),
  }
}

/** The final answer text: the `result` line, else the newest response. */
export function streamFinalText(s: StreamState, maxChars = 2000): string | undefined {
  const t = (s.result?.text.trim() || s.lastResponseText || "").trim()
  if (!t) return undefined
  return t.length <= maxChars ? t : `${t.slice(0, maxChars - 1).trimEnd()}…`
}

/** A one-line failure cause for a failed/aborted run, or `undefined`. */
export function streamFailure(s: StreamState): string | undefined {
  const outcome = s.result?.outcome ?? s.outcome
  // `waiting` = the loop paused on a permanent error. Headless, nobody resumes
  // it, so with an error it is a failure too.
  const failed =
    outcome === "failed" ||
    outcome === "aborted" ||
    (outcome === "waiting" && s.error !== undefined)
  if (!failed) return undefined
  if (s.error) {
    const hint = s.error.hint ? ` (hint: ${oneLine(s.error.hint, 120)})` : ""
    return `${oneLine(s.error.message, 220)}${hint}`
  }
  return outcome === "aborted" ? "run aborted" : "run failed"
}

/** Human lines for `AgentOutput`: `HH:MM:SS → Bash: bun test`. */
export function activityLines(s: StreamState, max = 14): string[] {
  const glyph: Record<StreamActivity["kind"], string> = {
    tool: "→",
    tool_error: "✘",
    text: "·",
    notice: "!",
    error: "✘",
  }
  const lines = s.activity.slice(-max).map((a) => {
    const hhmmss = a.ts > 0 ? new Date(a.ts).toISOString().slice(11, 19) : "--:--:--"
    return `${hhmmss} ${glyph[a.kind]} ${oneLine(a.text, 96)}`
  })
  if (s.phase === "writing" && s.liveText.trim()) {
    lines.push(`   now  ✎ ${oneLine(s.liveText, 96)}`)
  } else if (s.phase === "thinking") {
    lines.push("   now  … thinking")
  }
  return lines
}

// ---------------------------------------------------------------------------
// Incremental reader (the only IO)
// ---------------------------------------------------------------------------

/** Injectable IO for {@link streamReader}. */
export interface StreamReaderDeps {
  /** Byte size of the file, or `null` when absent. */
  readonly size: (path: string) => number | null
  /** Read `length` bytes at `offset` as UTF-8. */
  readonly readRange: (path: string, offset: number, length: number) => string
  /** Optional raw-byte reader so newline byte offsets never drift on invalid UTF-8. */
  readonly readBytes?: (path: string, offset: number, length: number) => Buffer
}

/** Production deps: `statSync` + a positioned `readSync`. */
export function realStreamReaderDeps(): StreamReaderDeps {
  const readBytes = (p: string, offset: number, length: number): Buffer => {
    const fd = openSync(p, "r")
    try {
      const buf = Buffer.alloc(length)
      const n = readSync(fd, buf, 0, length, offset)
      return buf.subarray(0, n)
    } finally {
      closeSync(fd)
    }
  }
  return {
    size: (p) => {
      try {
        return statSync(p).size
      } catch {
        return null
      }
    },
    readBytes,
    readRange: (p, offset, length) => readBytes(p, offset, length).toString("utf-8"),
  }
}

/** Largest read per tick, so one huge append never stalls the 1s heartbeat. */
const MAX_READ_BYTES = 4 * 1024 * 1024

/**
 * A cached, incremental stream reader. Each call reads only the bytes appended
 * since the previous call for that path and folds them into a per-path
 * {@link StreamState}. A file that shrank (rotated / rewritten) is re-read from
 * zero. Returns `undefined` when the file does not exist.
 *
 * A UTF-8 character split across two reads would decode as U+FFFD, so the
 * reader only consumes up to the last `\n` byte it saw and re-reads the tail.
 * If a single line exceeds {@link MAX_READ_BYTES}, the reader skips past that
 * oversized line instead of wedging forever.
 */
export function streamReader(
  deps: StreamReaderDeps = realStreamReaderDeps(),
): (path: string) => StreamState | undefined {
  const cache = new Map<
    string,
    { offset: number; state: StreamState; skippingOversized: boolean }
  >()
  return (path) => {
    const size = deps.size(path)
    if (size === null) return cache.get(path)?.state
    let entry = cache.get(path)
    if (!entry || size < entry.offset) {
      entry = { offset: 0, state: createStreamState(), skippingOversized: false }
      cache.set(path, entry)
    }
    if (size > entry.offset) {
      const length = Math.min(size - entry.offset, MAX_READ_BYTES)
      if (deps.readBytes) {
        const buf = deps.readBytes(path, entry.offset, length)
        if (entry.skippingOversized) {
          const nl = buf.indexOf(0x0a)
          if (nl >= 0) {
            entry.offset += nl + 1
            entry.skippingOversized = false
            const rest = buf.subarray(nl + 1)
            const lastNl = rest.lastIndexOf(0x0a)
            if (lastNl >= 0) {
              feedStream(entry.state, rest.subarray(0, lastNl + 1).toString("utf-8"))
              entry.offset += lastNl + 1
            }
          } else if (buf.length === MAX_READ_BYTES) {
            entry.offset += buf.length
          }
        } else {
          const cut = buf.lastIndexOf(0x0a)
          if (cut >= 0) {
            feedStream(entry.state, buf.subarray(0, cut + 1).toString("utf-8"))
            entry.offset += cut + 1
          } else if (buf.length === MAX_READ_BYTES) {
            // Single NDJSON line exceeds MAX_READ_BYTES; skip past it so offset never wedges.
            entry.offset += buf.length
            entry.skippingOversized = true
          }
        }
      } else {
        const chunk = deps.readRange(path, entry.offset, length)
        if (entry.skippingOversized) {
          const nl = chunk.indexOf("\n")
          if (nl >= 0) {
            entry.offset += Buffer.byteLength(chunk.slice(0, nl + 1), "utf-8")
            entry.skippingOversized = false
            const rest = chunk.slice(nl + 1)
            const lastNl = rest.lastIndexOf("\n")
            if (lastNl >= 0) {
              const whole = rest.slice(0, lastNl + 1)
              feedStream(entry.state, whole)
              entry.offset += Buffer.byteLength(whole, "utf-8")
            }
          } else if (length === MAX_READ_BYTES) {
            entry.offset += length
          }
        } else {
          const cut = chunk.lastIndexOf("\n")
          if (cut >= 0) {
            const whole = chunk.slice(0, cut + 1)
            feedStream(entry.state, whole)
            entry.offset += Buffer.byteLength(whole, "utf-8")
          } else if (length === MAX_READ_BYTES) {
            entry.offset += length
            entry.skippingOversized = true
          }
        }
      }
    }
    return entry.state
  }
}
