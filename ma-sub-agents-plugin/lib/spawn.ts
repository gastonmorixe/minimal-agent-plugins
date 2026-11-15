/**
 * The imperative shell around launching + probing worker processes.
 *
 * All OS interaction (spawn, pid-liveness, reading the result sentinel) is
 * funnelled through injected {@link SpawnDeps} / {@link ProbeDeps} so the
 * surrounding logic is unit-testable with fakes — the real `Bun.spawn` /
 * `process.kill` / `readFileSync` live only in {@link realSpawnDeps} /
 * {@link realProbeDeps}.
 *
 * Result transport is the "subagent output to filesystem" pattern (Anthropic's
 * game-of-telephone fix): a worker writes a tiny `<sid>.result.json` sentinel as
 * its last act; the supervisor reads THAT, not the worker's transcript — and it
 * reads the sentinel even while the pid is still alive, because `ReportResult`
 * does not kill the process. When the sentinel is absent the supervisor falls
 * back to distilled final text / incomplete in {@link supervisorTick}.
 *
 * @module sub-agents/lib/spawn
 */

import { existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs"
import { dirname } from "node:path"

import { childEnv } from "@minimal-agent/core/plugin-api/utils/self-spawn"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { parseFinalText, parseProgress } from "./progress.ts"
import {
  type StreamState,
  streamEnded,
  streamFailure,
  streamFinalText,
  streamProgress,
  streamReader,
} from "./stream.ts"
import type { SpawnPlan } from "./spawn-plan.ts"
import type { WorkerProbe } from "./supervisor.ts"
import { err, ok, type Progress, type Result, type ResultDigest } from "./types.ts"

/**
 * Where a worker's stdout (its stream-json event lines) is captured. Not
 * `.jsonl`: session scanners treat every `*.jsonl` in the sessions dir as a
 * session transcript.
 */
export function streamPathFor(sessionsDir: string, sid: string): string {
  return `${sessionsDir}/${sid}.stream.ndjson`
}

/** Env key telling a worker where to write its result sentinel. */
export const ENV_RESULT_PATH = "MINIMAL_AGENT_SUBAGENT_RESULT_PATH"

// ---------------------------------------------------------------------------
// Injected dependencies (DIP — fakes in tests, real OS calls in prod)
// ---------------------------------------------------------------------------

/** Side-effects needed to launch a worker. */
export interface SpawnDeps {
  /** Launch a worker process; return its pid. Throws on failure. */
  readonly launch: (
    argv: readonly string[],
    opts: {
      cwd: string
      env: Record<string, string>
      /** stderr capture (and stdout too when `streamPath` is absent). */
      logPath: string
      /** stdout capture: the child's stream-json event lines. */
      streamPath?: string
    },
  ) => number
}

/** Side-effects needed to probe a worker. */
export interface ProbeDeps {
  /** True if the pid is still alive. */
  readonly pidAlive: (pid: number) => boolean
  /** Read + validate the worker's result sentinel, or `undefined` if absent/malformed. */
  readonly readResult: (path: string) => ResultDigest | undefined
  /** Derive live progress from the worker's transcript, or `undefined` if unreadable. */
  readonly readProgress?: (transcriptPath: string) => Progress | undefined
  /**
   * Distill the worker's FINAL assistant message from its transcript, or
   * `undefined` when there is none. The fallback when no sentinel was written.
   */
  readonly readFinalText?: (transcriptPath: string) => string | undefined
  /**
   * Of the given paths, return those that DON'T exist or are empty. Used to
   * enforce the `expectArtifacts` contract (FIX 4). Pure list in, list out.
   */
  readonly missingArtifacts?: (paths: readonly string[]) => string[]
  /** Exit code of an exited pid, if known (best-effort; `undefined` when unknowable). */
  readonly exitCode?: (pid: number) => number | undefined
  /**
   * Read a short, actionable crash signature from the worker's stdout/stderr
   * log, or `undefined` when the log shows no fatal error (FIX A). This is what
   * turns a startup crash (bad model, missing beta, ENOENT) from a generic
   * "incomplete · exited without a result" into a `failed` carrying the real
   * cause. Only consulted for a worker that exited producing NOTHING (no
   * sentinel, no distillable final message), so its false-positive surface is
   * limited to genuinely silent exits.
   */
  readonly readCrash?: (logPath: string) => string | undefined
  /**
   * Fold the worker's stream-json stdout into a {@link StreamState}, or
   * `undefined` when there is no stream file (an old worker). When present it
   * is the primary source: progress, final text, outcome and failure cause.
   * The transcript and log readers stay as fallbacks.
   */
  readonly readStream?: (streamPath: string) => StreamState | undefined
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/**
 * Execute a {@link SpawnPlan}: launch the worker. (The `fork` isolation tier
 * needs no pre-step — the plan's argv carries `--resume <leadSid>`, and the
 * agent's own resume path forks the lead's history into the child's pinned
 * sid.) Returns the pid in a {@link Result} (no throw).
 */
export function launchWorker(
  plan: SpawnPlan,
  deps: SpawnDeps,
  logPath: string,
  streamPath?: string,
): Result<number> {
  try {
    const pid = deps.launch(plan.argv, {
      cwd: plan.cwd,
      env: plan.env,
      logPath,
      ...(streamPath ? { streamPath } : {}),
    })
    return ok(pid)
  } catch (e) {
    return err(`spawn failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/** What {@link probeWorker} needs to locate a worker's files. */
export interface ProbeTarget {
  readonly pid: number
  readonly resultPath: string
  readonly transcriptPath: string
  /** The worker's stdout/stderr capture, mined for a crash signature (FIX A). */
  readonly logPath?: string
  /** Paths the worker was contracted to produce (the `expectArtifacts` set). */
  readonly expectArtifacts?: readonly string[]
  /** The worker's stream-json stdout capture. */
  readonly streamPath?: string
}

/**
 * Build a {@link WorkerProbe} for a running worker: is it alive (and if so its
 * live progress), did it leave a result sentinel, what was its exit code. Pure
 * given the deps.
 *
 * Important: the result sentinel is read EVEN WHILE THE PID IS ALIVE. Workers
 * call `ReportResult` (which writes `<sid>.result.json`) and then often linger —
 * they may `end_turn` without the process exiting. If the probe skipped the
 * sentinel until death, the supervisor would keep the worker `running` until a
 * deadline and mark it `failed` with "No result" despite a rich handoff on disk
 * (Dorothy A1/A2). Distillation / crash mining stay exit-only: mid-turn assistant
 * text must not false-trigger completion.
 */
export function probeWorker(target: ProbeTarget, deps: ProbeDeps): WorkerProbe {
  const alive = deps.pidAlive(target.pid)
  const rawResult = deps.readResult(target.resultPath)
  // FIX 3: a worker can CLAIM artifacts in its sentinel without writing them.
  // Cross-check the sentinel's own `artifacts[]` and prepend a loud warning to
  // the summary for any that are missing/empty, so a forgetful/lying worker is
  // caught automatically. The worker still counts as `done` (it reported), but
  // the lead reads the discrepancy.
  const result = rawResult ? warnMissingDeclared(rawResult, deps) : undefined
  // Enforce the deliverable contract whenever we have a contracted set — needed
  // while alive too, so a sentinel + missing expectArtifacts can finalize as
  // incomplete without waiting for process death.
  const missingArtifacts =
    target.expectArtifacts && target.expectArtifacts.length > 0
      ? deps.missingArtifacts?.(target.expectArtifacts)
      : undefined

  // The stream-json stdout is the primary telemetry source. It is read
  // incrementally (only new bytes per tick). The transcript stays the fallback
  // for an old worker launched without a stream file.
  const stream = target.streamPath ? deps.readStream?.(target.streamPath) : undefined
  // Read progress alive AND dead: a fast worker can exit (or write its
  // sentinel) before any tick saw it running, and the final counts must
  // still come from its stream / transcript.
  const progress =
    (stream ? streamProgress(stream) : undefined) ?? deps.readProgress?.(target.transcriptPath)
  const durationMs = stream?.result?.durationMs
  // A failed run as the child itself reported it. Structural, so unlike a
  // log-mined crash it is trusted even when the worker left partial text.
  const runFailed = stream ? streamFailure(stream) : undefined
  const streamFields = {
    ...(stream && streamEnded(stream) ? { runEnded: true } : {}),
    ...(durationMs ? { durationMs } : {}),
    ...(runFailed ? { runFailed } : {}),
  }
  // While alive, distillation and crash mining are skipped (mid-turn text is
  // not a final answer) — unless the stream already proved the run ended. Then
  // the process is only lingering (open child, slow exit), and its answer is
  // final.
  if (alive && !streamFields.runEnded) {
    return {
      alive: true,
      ...(progress ? { progress } : {}),
      ...(result ? { result } : {}),
      ...(missingArtifacts && missingArtifacts.length > 0 ? { missingArtifacts } : {}),
      ...streamFields,
    }
  }

  const exitCode = alive ? undefined : deps.exitCode?.(target.pid)
  // Distillation fallback: only bother reading the final message when the worker
  // left NO structured sentinel — the sentinel always wins (see supervisorTick
  // precedence). Exit-only: while alive a "final" message may just be mid-turn
  // chatter. The stream's `result.text` is the exact final answer; the
  // transcript parse is the fallback.
  const distilled = result
    ? undefined
    : ((stream ? streamFinalText(stream) : undefined) ??
      deps.readFinalText?.(target.transcriptPath))
  // A worker that exited producing NOTHING — no sentinel AND no distillable
  // final message — is where a crash hides. The stream already named the cause
  // structurally above (`runFailed`: `error` + `run_finished: failed`, written
  // even for a boot failure). Log mining (FIX A) is the fallback for an old
  // worker or a death before the stream writer ran (the binary did not start).
  const silent = !result && !(distilled && distilled.trim().length > 0)
  const crash =
    silent && !runFailed && target.logPath ? deps.readCrash?.(target.logPath) : undefined
  return {
    alive,
    ...(progress ? { progress } : {}),
    ...(result ? { result } : {}),
    ...(distilled ? { distilled } : {}),
    ...(missingArtifacts && missingArtifacts.length > 0 ? { missingArtifacts } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(crash ? { crash } : {}),
    ...streamFields,
  }
}

/**
 * FIX 3: cross-check a sentinel's self-declared `artifacts[]` against disk and
 * prepend a `⚠ N/M artifacts missing: …` note to `short` for any that don't
 * exist or are empty. Pure given `deps.missingArtifacts`; a no-op when the
 * sentinel declared no artifacts or the dep is absent.
 */
export function warnMissingDeclared(result: ResultDigest, deps: ProbeDeps): ResultDigest {
  const declared = result.artifacts
  if (!declared || declared.length === 0 || !deps.missingArtifacts) return result
  const missing = deps.missingArtifacts(declared)
  if (missing.length === 0) return result
  const warn = `⚠ ${missing.length}/${declared.length} declared artifact(s) missing: ${missing.join(", ")}. `
  return { ...result, short: warn + result.short }
}

// ---------------------------------------------------------------------------
// Real implementations
// ---------------------------------------------------------------------------

/**
 * FIX A: extract a short, actionable crash signature from a worker's
 * stdout/stderr log, or `undefined` when nothing fatal is present. Pure (string
 * in, string out) so it is unit-testable without a filesystem.
 *
 * Strategy: strip ANSI, scan for the first line that looks like a hard failure
 * (`fatal:`, an uncaught `Error:`, an API `4xx/5xx`, a Node `ENOENT`/`EACCES`,
 * or an `unknown model`/`--model` complaint), and return a clipped one-liner.
 * The signature is intentionally the FIRST such line — a boot crash prints its
 * cause before any downstream noise. Returns `undefined` for an empty/benign log
 * so the caller only escalates to `failed` when there is a real cause to report.
 */
export function extractCrashSignature(logText: string): string | undefined {
  const clean = stripAnsi(logText)
  const lines = clean
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  // Patterns ordered by specificity; the first match on any line wins.
  const patterns: RegExp[] = [
    /^fatal:/i,
    /\bAPI\s+\d{3}\b/, // "API 400: ..."
    /"type"\s*:\s*"[a-z_]*error"/i, // anthropic/openai error envelope
    /\b(unknown|unsupported|invalid)\s+model\b/i,
    /\bmodel\b.*\b(not\s+found|does\s+not\s+exist|unavailable)\b/i,
    /\bbeta\b.*\b(not|unavailable|unsupported)\b/i,
    /\b(ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT)\b/,
    /^(Uncaught|Unhandled)\b/i,
    /^[A-Za-z.]*Error:/, // "TypeError: ...", "Error: ..."
    /\bcommand not found\b/i,
  ]
  for (const line of lines) {
    for (const re of patterns) {
      if (re.test(line)) return clip1(line, 240)
    }
  }
  return undefined
}

/** Clip to one bounded line (collapse whitespace, ellipsize). */
function clip1(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}

/** Validate an untrusted parsed object as a {@link ResultDigest}. */
export function parseResultDigest(raw: unknown): ResultDigest | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.short !== "string") return undefined
  const tokens = typeof o.tokens === "number" && Number.isFinite(o.tokens) ? o.tokens : 0
  const tools = typeof o.tools === "number" && Number.isFinite(o.tools) ? o.tools : 0
  const artifacts = Array.isArray(o.artifacts)
    ? o.artifacts.filter((a): a is string => typeof a === "string")
    : undefined
  // A worker reports incompletion either structurally (`incomplete: true`, what
  // buildDigest now writes) or by the legacy hand-written `INCOMPLETE:` summary
  // prefix (the documented manual-sentinel fallback). Honor both so the
  // supervisor never launders a self-flagged incompletion into `done`.
  const incomplete = o.incomplete === true || /^\s*INCOMPLETE:/.test(o.short)
  return {
    short: o.short,
    tokens,
    tools,
    ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
    ...(incomplete ? { incomplete: true } : {}),
  }
}

/**
 * The env a worker process starts with. The plan env is an OVERLAY: a real
 * worker still needs the parent's PATH / HOME / credentials, so `base`
 * (default `process.env`) sits underneath it. `BUN_BE_BUN` is stripped from
 * the result (core `childEnv`): a compiled `minimal-agent` that inherits it
 * would boot as the plain `bun` CLI instead of the agent.
 */
export function workerEnv(
  overlay: Readonly<Record<string, string>>,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  return childEnv({ ...base, ...overlay })
}

/**
 * Production spawn deps: `Bun.spawn` with stdout → the stream file (the
 * child's stream-json events) and stderr → the log file. Without a
 * `streamPath` both go to the log (the old layout).
 */
export function realSpawnDeps(): SpawnDeps {
  return {
    launch: (argv, opts) => {
      mkdirSync(dirname(opts.logPath), { recursive: true })
      const fd = openSync(opts.logPath, "a")
      const outFd = opts.streamPath ? openSync(opts.streamPath, "a") : fd
      // Not detached: the worker stays a real child of the lead so a forced
      // lead exit still closes its stdio. (Detached was previously claimed in
      // a comment but never set — and would make lead-exit reaping harder.)
      // The supervisor / agent.willStop path SIGKILLs lingering pids explicitly.
      const proc = (
        globalThis as unknown as { Bun: { spawn: (cmd: string[], o: object) => { pid: number } } }
      ).Bun.spawn(
        [...argv],
        // The plan env is an OVERLAY over process.env (see workerEnv).
        {
          cwd: opts.cwd,
          env: workerEnv(opts.env),
          stdin: "ignore",
          stdout: outFd,
          stderr: fd,
        },
      )
      return proc.pid
    },
  }
}

/** Injectable IO for {@link cachedProgressReader} (tests stub these). */
export interface ProgressReaderDeps {
  /** mtime (ms) of a file, or `null` when absent/unreadable. */
  readonly stat: (path: string) => number | null
  readonly read: (path: string) => string
  readonly parse: (text: string) => Progress
}

/**
 * A progress reader that re-parses a worker's transcript ONLY when its mtime
 * changed since the last read. At a fleet of 100 workers the supervisor probes
 * every second; without this it would re-parse 100 transcripts/s even when
 * idle. The cache is keyed by path; bounded by the number of distinct workers.
 */
export function cachedProgressReader(
  deps: ProgressReaderDeps,
): (path: string) => Progress | undefined {
  const cache = new Map<string, { mtimeMs: number; progress: Progress }>()
  return (path: string) => {
    const mtimeMs = deps.stat(path)
    if (mtimeMs === null) return undefined
    const hit = cache.get(path)
    if (hit && hit.mtimeMs === mtimeMs) return hit.progress
    const progress = deps.parse(deps.read(path))
    cache.set(path, { mtimeMs, progress })
    return progress
  }
}

/** Production probe deps: `process.kill(pid, 0)` liveness + sentinel JSON read. */
export function realProbeDeps(): ProbeDeps {
  const readProgress = cachedProgressReader({
    stat: (p) => {
      try {
        return statSync(p).mtimeMs
      } catch {
        return null
      }
    },
    read: (p) => readFileSync(p, "utf-8"),
    parse: parseProgress,
  })
  const readStream = streamReader()
  return {
    readStream,
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    readResult: (path) => {
      if (!existsSync(path)) return undefined
      try {
        return parseResultDigest(JSON.parse(readFileSync(path, "utf-8")))
      } catch {
        return undefined
      }
    },
    readProgress,
    readFinalText: (path) => {
      try {
        return parseFinalText(readFileSync(path, "utf-8"))
      } catch {
        return undefined
      }
    },
    missingArtifacts: (paths) =>
      paths.filter((p) => {
        try {
          // missing if it doesn't exist OR exists but is empty (0 bytes)
          return statSync(p).size === 0
        } catch {
          return true
        }
      }),
    readCrash: (logPath) => {
      try {
        if (!existsSync(logPath)) return undefined
        // Logs are tiny for a boot crash (a line or two). Cap the read so a
        // chatty worker's multi-MB log never blocks the 1s supervisor tick.
        const text = readFileSync(logPath, "utf-8")
        return extractCrashSignature(text.length > 64_000 ? text.slice(0, 64_000) : text)
      } catch {
        return undefined
      }
    },
  }
}
