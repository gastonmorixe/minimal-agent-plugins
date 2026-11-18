/**
 * Fake-fleet replay harness (lane plan H5).
 *
 * Replays recorded worker sessions into a sessions directory, so the real
 * plugin code that reads the fleet and the worker files runs against real
 * worker data:
 *
 *  - the fleet file `<leadSid>.subagents.jsonl`, written with the plugin's own
 *    {@link SubagentStore} (`store.ts`): a `running` record at spawn in the
 *    shape `service.ts` writes, the `progress` refresh that the supervisor
 *    writes on each tick (`supervisor.ts`, step 4), and at the end the
 *    terminal record that the real run stored;
 *  - `<sid>.stream.ndjson` (path from {@link streamPathFor}), appended one
 *    line at a time, at the recorded `ts` of each line;
 *  - `<sid>.jsonl`, the session transcript, appended in the same way.
 *
 * A fixture is three files in `lib/__fixtures__/lane/` (see its README.md and
 * `scrub-fixture.ts`). Time is injectable: {@link FleetReplay.step} applies
 * one event with no wait (tests), {@link FleetReplay.run} waits with a
 * {@link ReplayClock} at 1x, 10x or any speed (a dev command).
 *
 * The harness never reads or writes `~/.minimal-agent`: the caller gives the
 * sessions directory.
 *
 * @module sub-agents/lib/lane/replay-harness
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { streamPathFor } from "../spawn.ts"
import { parseRecords, SubagentStore } from "../store.ts"
import { streamProgress, streamReader } from "../stream.ts"
import {
  type SessionId,
  type SubagentId,
  type SubagentRecord,
  sessionId,
  ZERO_PROGRESS,
} from "../types.ts"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The directory of the recorded lane fixtures. */
export const LANE_FIXTURES_DIR = fileURLToPath(new URL("../__fixtures__/lane/", import.meta.url))

/** The six recorded workers, by fixture name, with their category. */
export const LANE_FIXTURES = {
  "quick-explorer": "a quick explorer",
  "long-edit-write": "a long worker with Edit and Write",
  failing: "a failing worker",
  stalled: "a stalled worker",
  notice: "a worker with a notice",
  incomplete: "a worker that ends incomplete",
} as const

/** The name of one recorded fixture. */
export type LaneFixtureName = keyof typeof LANE_FIXTURES

/** One recorded worker: its stream lines, transcript lines and fleet record. */
export interface LaneFixture {
  readonly name: string
  /** `<sid>.stream.ndjson` lines, without `\n`. */
  readonly stream: readonly string[]
  /** `<sid>.jsonl` lines, without `\n`. */
  readonly transcript: readonly string[]
  /** The last fleet record of the real run (a terminal status). */
  readonly record: SubagentRecord
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((l) => l.trim().length > 0)
}

/** Load one fixture (three files) from `dir`. */
export function loadLaneFixture(name: string, dir: string = LANE_FIXTURES_DIR): LaneFixture {
  const read = (suffix: string) => readFileSync(`${dir}/${name}${suffix}`, "utf-8")
  const record = parseRecords(read(".fleet.jsonl"))[0]
  if (!record) throw new Error(`fixture ${name}: no fleet record`)
  return {
    name,
    stream: nonEmptyLines(read(".stream.ndjson")),
    transcript: nonEmptyLines(read(".jsonl")),
    record,
  }
}

/** Load all six recorded fixtures, in {@link LANE_FIXTURES} order. */
export function loadLaneFixtures(dir: string = LANE_FIXTURES_DIR): LaneFixture[] {
  return Object.keys(LANE_FIXTURES).map((n) => loadLaneFixture(n, dir))
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/** Injectable time for {@link FleetReplay.run}. */
export interface ReplayClock {
  /** Epoch ms now. */
  readonly now: () => number
  /** Wait `ms` milliseconds. */
  readonly sleep: (ms: number) => Promise<void>
}

/** The real clock: `Date.now` and `setTimeout`. */
export function systemClock(): ReplayClock {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

/** A manual clock for tests: `sleep` returns at once and moves `now` forward. */
export interface ManualClock extends ReplayClock {
  /** Each wait, in order (ms). */
  readonly sleeps: number[]
}

/** Make a {@link ManualClock} that starts at `startMs`. */
export function manualClock(startMs = 0): ManualClock {
  let t = startMs
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: (ms) => {
      sleeps.push(ms)
      t += ms
      return Promise.resolve()
    },
    sleeps,
  }
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/** One replay step. `at` is ms from the replay start. `worker` is an index. */
export type ReplayEvent =
  | { readonly kind: "spawn"; readonly worker: number; readonly at: number }
  | {
      readonly kind: "stream" | "transcript"
      readonly worker: number
      readonly at: number
      /** 1-based line number in the fixture file. */
      readonly line: number
      /** The bytes to append: a whole line with `\n`, or a part of it. */
      readonly bytes: Uint8Array
    }
  | { readonly kind: "finish"; readonly worker: number; readonly at: number }

/** A short name of an event for goldens and logs: `stream:12`. */
export function eventLabel(e: ReplayEvent): string {
  return e.kind === "stream" || e.kind === "transcript" ? `${e.kind}:${e.line}` : e.kind
}

function isoMs(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : undefined
}

function lineTs(line: string): number | undefined {
  try {
    const ts = (JSON.parse(line) as { ts?: unknown }).ts
    return typeof ts === "number" && Number.isFinite(ts) ? ts : isoMs(ts)
  } catch {
    return undefined
  }
}

/** Shift the `ts` of one line by `shift` ms (numbers stay numbers, ISO stays ISO). */
function shiftLineTs(line: string, shift: number): string {
  if (shift === 0) return line
  try {
    const obj = JSON.parse(line) as { ts?: unknown }
    if (typeof obj.ts === "number") obj.ts += shift
    else if (isoMs(obj.ts) !== undefined)
      obj.ts = new Date((isoMs(obj.ts) ?? 0) + shift).toISOString()
    else return line
    return JSON.stringify(obj)
  } catch {
    return line
  }
}

/** Split a line in two appends at its byte middle (it can cut a UTF-8 char). */
function splitLine(buf: Buffer): readonly [Buffer, Buffer] {
  const mid = Math.max(1, Math.floor(buf.length / 2))
  return [buf.subarray(0, mid), buf.subarray(mid)]
}

/** The recorded epoch ms where a worker's timeline starts (spawn or first line). */
function workerBase(fixture: LaneFixture): number {
  const firsts = [
    isoMs(fixture.record.spawnedAt),
    ...fixture.stream.slice(0, 1).map(lineTs),
    ...fixture.transcript
      .map(lineTs)
      .filter((t) => t !== undefined)
      .slice(0, 1),
  ].filter((t): t is number => t !== undefined)
  return firsts.length > 0 ? Math.min(...firsts) : 0
}

/** Order of kinds at the same instant: spawn, stream, transcript, finish. */
const KIND_ORDER: Record<ReplayEvent["kind"], number> = {
  spawn: 0,
  stream: 1,
  transcript: 2,
  finish: 3,
}

/**
 * The events of one worker. `at` = recorded time - `base` + `offsetMs`.
 * `shift` moves the `ts` inside the written lines (0 keeps them).
 */
function planWorker(
  fixture: LaneFixture,
  worker: number,
  offsetMs: number,
  shift: number,
  split: boolean,
): ReplayEvent[] {
  const base = workerBase(fixture)
  const events: ReplayEvent[] = [{ kind: "spawn", worker, at: offsetMs }]
  let last = offsetMs
  const add = (kind: "stream" | "transcript", lines: readonly string[]) => {
    let prev = offsetMs
    lines.forEach((raw, i) => {
      const ts = lineTs(raw)
      const at = ts === undefined ? prev : Math.max(offsetMs, ts - base + offsetMs)
      prev = at
      last = Math.max(last, at)
      const bytes = Buffer.from(`${shiftLineTs(raw, shift)}\n`, "utf-8")
      if (split) {
        for (const part of splitLine(bytes)) {
          events.push({ kind, worker, at, line: i + 1, bytes: part })
        }
      } else {
        events.push({ kind, worker, at, line: i + 1, bytes })
      }
    })
  }
  add("stream", fixture.stream)
  add("transcript", fixture.transcript)
  const status = fixture.record.status
  const ended = "endedAt" in status ? isoMs(status.endedAt) : undefined
  const finishAt = Math.max(last, ended === undefined ? last : ended - base + offsetMs)
  events.push({ kind: "finish", worker, at: finishAt })
  return events
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/** Options of {@link createFleetReplay}. */
export interface FleetReplayOptions {
  /** The sessions directory to write into (a temp dir in tests). */
  readonly sessionsDir: string
  /** The lead session id of the fleet file. */
  readonly leadSid: string
  readonly fixtures: readonly LaneFixture[]
  /** Start offset of each worker, ms from the replay start (default all 0). */
  readonly startOffsetsMs?: readonly number[]
  /**
   * Shift every recorded time so the replay start is this epoch ms (for a
   * live demo, so "idle" hints are true). Default: keep the recorded times.
   */
  readonly rebaseToMs?: number
  /** Give ids `A1`, `A2`, … in fixture order with {@link SubagentStore.nextId} (default true). */
  readonly renumber?: boolean
  /** Write the supervisor's `progress` refresh to the fleet after each stream append (default true). */
  readonly syncFleet?: boolean
  /** Append each line in two parts (the second step ends the line). Default false. */
  readonly splitLines?: boolean
  /** The pid of worker `i` (default `4_000_000 + i`, above any real pid). */
  readonly pidFor?: (worker: number) => number
}

/** Options of {@link FleetReplay.run}. */
export interface ReplayRunOptions {
  /** Replay speed: 1 is real time, 10 is ten times faster. Default 1. */
  readonly speed?: number
  readonly clock?: ReplayClock
  /** Shorten each wait between two events to at most this many replay ms. */
  readonly maxGapMs?: number
  /** Stop between two events when aborted. */
  readonly signal?: AbortSignal
  /** Called after each applied event. */
  readonly onEvent?: (e: ReplayEvent) => void
}

/** One live worker of a replay: its handle and file paths. */
export interface ReplayWorker {
  readonly id: SubagentId
  readonly sid: SessionId
  readonly pid: number
  readonly streamPath: string
  readonly transcriptPath: string
  readonly fixture: LaneFixture
}

/** A replay in progress. Make one with {@link createFleetReplay}. */
export class FleetReplay {
  /** The fleet store, the plugin's own repository class. */
  readonly store: SubagentStore
  /** All events, sorted by time. */
  readonly events: readonly ReplayEvent[]
  /** The workers, in fixture order. */
  readonly workers: readonly ReplayWorker[]
  private next = 0
  private readonly ids: SubagentId[] = []
  private readonly readStream = streamReader()
  /** Per worker: ms added to each recorded time (0 without `rebaseToMs`). */
  private readonly shifts: readonly number[]

  constructor(private readonly opts: FleetReplayOptions) {
    mkdirSync(opts.sessionsDir, { recursive: true })
    this.store = new SubagentStore(opts.leadSid, { dir: opts.sessionsDir })
    const offsets = opts.fixtures.map((_f, i) => opts.startOffsetsMs?.[i] ?? 0)
    // A recorded time t is written as rebaseToMs + (t - base) + offset, the
    // same instant as its event `at` from the replay start.
    this.shifts = opts.fixtures.map((f, i) =>
      opts.rebaseToMs === undefined ? 0 : opts.rebaseToMs + (offsets[i] ?? 0) - workerBase(f),
    )
    this.events = opts.fixtures
      .flatMap((f, i) =>
        planWorker(f, i, offsets[i] ?? 0, this.shifts[i] ?? 0, opts.splitLines ?? false),
      )
      .map((e, seq) => ({ e, seq }))
      .sort(
        (a, b) => a.e.at - b.e.at || KIND_ORDER[a.e.kind] - KIND_ORDER[b.e.kind] || a.seq - b.seq,
      )
      .map((x) => x.e)
    this.workers = opts.fixtures.map((f, i) => ({
      id: f.record.id,
      sid: f.record.sid,
      pid: opts.pidFor?.(i) ?? 4_000_000 + i,
      streamPath: streamPathFor(opts.sessionsDir, f.record.sid),
      transcriptPath: `${opts.sessionsDir}/${f.record.sid}.jsonl`,
      fixture: f,
    }))
  }

  /** True when every event was applied. */
  get done(): boolean {
    return this.next >= this.events.length
  }

  /** The handle id of worker `i` (after its spawn event). */
  idOf(worker: number): SubagentId | undefined {
    return this.ids[worker]
  }

  /** Apply the next event with no wait. Returns it, or `undefined` at the end. */
  step(): ReplayEvent | undefined {
    const e = this.events[this.next]
    if (!e) return undefined
    this.next++
    this.apply(e)
    return e
  }

  /** Apply every remaining event with no wait. Returns how many. */
  stepAll(): number {
    let n = 0
    while (this.step()) n++
    return n
  }

  /**
   * Apply the remaining events in time: wait `(at - previous at) / speed` on
   * the clock before each one. Returns how many were applied.
   */
  async run(o: ReplayRunOptions = {}): Promise<number> {
    const clock = o.clock ?? systemClock()
    const speed = o.speed && o.speed > 0 ? o.speed : 1
    let n = 0
    let prevAt = this.events[this.next - 1]?.at ?? 0
    let target = clock.now()
    while (!this.done) {
      if (o.signal?.aborted) break
      const e = this.events[this.next]
      if (!e) break
      const gap = Math.max(0, e.at - prevAt)
      prevAt = e.at
      target += (o.maxGapMs === undefined ? gap : Math.min(gap, o.maxGapMs)) / speed
      const wait = target - clock.now()
      if (wait > 0) await clock.sleep(wait)
      if (o.signal?.aborted) break
      this.step()
      o.onEvent?.(e)
      n++
    }
    return n
  }

  private apply(e: ReplayEvent): void {
    const w = this.workers[e.worker]
    if (!w) return
    switch (e.kind) {
      case "spawn":
        this.spawn(e.worker, w)
        break
      case "stream":
        appendFileSync(w.streamPath, e.bytes)
        if (this.opts.syncFleet ?? true) this.syncProgress(e.worker, w)
        break
      case "transcript":
        appendFileSync(w.transcriptPath, e.bytes)
        break
      case "finish":
        this.finish(e.worker, w)
        break
      default: {
        throw new Error(`unhandled replay event: ${String(e satisfies never)}`)
      }
    }
  }

  /** The `running` record, in the shape `service.ts` writes at spawn. */
  private spawn(i: number, w: ReplayWorker): void {
    const rec = w.fixture.record
    const id = (this.opts.renumber ?? true) ? this.store.nextId() : rec.id
    this.ids[i] = id
    const spawnedAt = this.shiftIso(rec.spawnedAt, i)
    const { status: _status, lastPid: _lastPid, ...rest } = rec
    const running: SubagentRecord = {
      ...rest,
      id,
      leadSid: sessionId(this.opts.leadSid),
      spawnedAt,
      status: { kind: "running", pid: w.pid, startedAt: spawnedAt, progress: ZERO_PROGRESS },
      lastPid: w.pid,
    }
    // The child's stdout redirect makes the stream file at launch.
    writeFileSync(w.streamPath, "")
    this.store.upsert(running)
  }

  /** The supervisor's step 4: a running record gets the probe's progress. */
  private syncProgress(i: number, w: ReplayWorker): void {
    const id = this.ids[i]
    if (!id) return
    const rec = this.store.get(id)
    if (!rec || rec.status.kind !== "running") return
    const s = this.readStream(w.streamPath)
    const progress = s ? streamProgress(s) : undefined
    if (!progress) return
    this.store.upsert({ ...rec, status: { ...rec.status, progress } })
  }

  /** The terminal record that the real run stored. */
  private finish(i: number, w: ReplayWorker): void {
    const id = this.ids[i]
    if (!id) return
    const rec = w.fixture.record
    const status =
      "endedAt" in rec.status
        ? { ...rec.status, endedAt: this.shiftIso(rec.status.endedAt, i) }
        : rec.status
    const prev = this.store.get(id)
    if (!prev) return
    this.store.upsert({ ...prev, status, lastPid: w.pid })
  }

  private shiftIso(iso: string, worker: number): string {
    const ms = isoMs(iso)
    const shift = this.shifts[worker] ?? 0
    if (ms === undefined || shift === 0) return iso
    return new Date(ms + shift).toISOString()
  }
}

/** Make a {@link FleetReplay}. Nothing is written until the first step. */
export function createFleetReplay(opts: FleetReplayOptions): FleetReplay {
  return new FleetReplay(opts)
}

/**
 * Replay the six recorded workers into `sessionsDir` in real time (the entry
 * point for a later dev command). Times are moved to now, and long idle gaps
 * are shortened to `maxGapMs` (default 5 s).
 */
export async function replayLaneFixtures(o: {
  readonly sessionsDir: string
  readonly leadSid: string
  /** Replay speed: 1 (real time), 10 (ten times faster) or any other. Default 1. */
  readonly speed?: number
  readonly maxGapMs?: number
  readonly clock?: ReplayClock
  readonly signal?: AbortSignal
}): Promise<FleetReplay> {
  const clock = o.clock ?? systemClock()
  const replay = createFleetReplay({
    sessionsDir: o.sessionsDir,
    leadSid: o.leadSid,
    fixtures: loadLaneFixtures(),
    rebaseToMs: clock.now(),
  })
  await replay.run({
    clock,
    speed: o.speed ?? 1,
    maxGapMs: o.maxGapMs ?? 5000,
    ...(o.signal ? { signal: o.signal } : {}),
  })
  return replay
}
