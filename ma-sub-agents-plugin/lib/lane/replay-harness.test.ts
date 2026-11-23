/**
 * Lane plan H5: the fake-fleet replay harness and the recorded fixtures.
 *
 * Golden: each fixture replays in stepped mode; after each step the plugin's
 * own reading path (`probeWorker` → `streamReader` → `streamProgress`, as the
 * supervisor tick runs it) must equal the golden in `goldens/`. Set
 * UPDATE_LANE_GOLDENS=1 to rewrite them.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { probeWorker } from "../spawn.ts"
import { streamProgress, streamReader } from "../stream.ts"
import { renderWidget } from "../widget.ts"

import {
  createFleetReplay,
  eventLabel,
  type FleetReplay,
  LANE_FIXTURES,
  LANE_FIXTURES_DIR,
  loadLaneFixture,
  loadLaneFixtures,
  manualClock,
} from "./replay-harness.ts"
import { findLeaks, scrubJsonLine, scrubString } from "./scrub-fixture.ts"

const UPDATE = process.env.UPDATE_LANE_GOLDENS === "1"
if (UPDATE && process.env.CI) {
  throw new Error("UPDATE_LANE_GOLDENS is on while CI is set. Refusing to rewrite goldens.")
}
const GOLDENS = join(import.meta.dir, "goldens")
const LEAD = "ba0ad20f-0000-4000-8000-000000000000"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "subagents-lane-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** The plugin's tick reading of worker 0, as `supervisor-shell.ts` probes it. */
function probeOf(r: FleetReplay, read: ReturnType<typeof streamReader>) {
  const w = r.workers[0]
  if (!w) throw new Error("no worker")
  return probeWorker(
    {
      pid: w.pid,
      resultPath: `${dir}/${w.sid}.result.json`,
      transcriptPath: w.transcriptPath,
      streamPath: w.streamPath,
    },
    { pidAlive: () => true, readResult: () => undefined, readStream: read },
  )
}

/** One golden row per step: the event, the fleet status, the probe reading. */
function goldenRows(name: string): string[] {
  const r = createFleetReplay({
    sessionsDir: dir,
    leadSid: LEAD,
    fixtures: [loadLaneFixture(name)],
  })
  const read = streamReader()
  const rows: string[] = []
  for (let e = r.step(); e; e = r.step()) {
    const probe = probeOf(r, read)
    const rec = r.store.all()[0]
    // The fleet the harness wrote holds the same progress the plugin reads.
    if (rec?.status.kind === "running" && probe.progress) {
      expect(rec.status.progress).toEqual(probe.progress)
    }
    rows.push(
      JSON.stringify({
        step: eventLabel(e),
        fleet: rec?.status.kind,
        ...(probe.runEnded ? { runEnded: true } : {}),
        ...(probe.runFailed ? { runFailed: probe.runFailed } : {}),
        progress: probe.progress ?? null,
      }),
    )
  }
  return rows
}

/** Matches a user name only as a path segment or before an address sign. A bare
 * match fails on a runner whose USER is an ordinary word ("runner"). */
function userNameRe(user: string): RegExp | null {
  if (user.length < 3) return null
  const escaped = user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`[/\\\\]${escaped}(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])${escaped}@`, "i")
}

describe("replay golden: streamProgress at each step", () => {
  for (const name of Object.keys(LANE_FIXTURES)) {
    test(name, () => {
      const rows = goldenRows(name)
      const path = join(GOLDENS, `${name}.progress.jsonl`)
      const text = `${rows.join("\n")}\n`
      if (UPDATE) writeFileSync(path, text)
      if (!existsSync(path)) {
        throw new Error(`missing golden ${path}. Run with UPDATE_LANE_GOLDENS=1.`)
      }
      expect(text).toBe(readFileSync(path, "utf-8"))
    })
  }
})

describe("replay harness", () => {
  test("fixture categories show in the final records and streams", () => {
    const byName = Object.fromEntries(loadLaneFixtures().map((f) => [f.name, f]))
    const kind = (n: string) => byName[n]?.record.status.kind
    expect(kind("quick-explorer")).toBe("done")
    expect(byName["quick-explorer"]?.record.type).toBe("explorer")
    expect(kind("long-edit-write")).toBe("done")
    const tools = (byName["long-edit-write"]?.stream ?? []).join("\n")
    expect(tools).toContain('"toolName":"Edit"')
    expect(tools).toContain('"toolName":"Write"')
    expect(kind("failing")).toBe("failed")
    expect(kind("stalled")).toBe("stopped")
    expect(byName.notice?.stream.some((l) => l.includes('"type":"notice"'))).toBe(true)
    expect(kind("incomplete")).toBe("incomplete")
  })

  test("the end state equals a one-shot read of the fixture stream", () => {
    for (const f of loadLaneFixtures()) {
      const local = mkdtempSync(join(dir, `${f.name}-`))
      const r = createFleetReplay({ sessionsDir: local, leadSid: LEAD, fixtures: [f] })
      r.stepAll()
      const w = r.workers[0]
      if (!w) throw new Error("no worker")
      expect(readFileSync(w.streamPath, "utf-8")).toBe(`${f.stream.join("\n")}\n`)
      expect(readFileSync(w.transcriptPath, "utf-8")).toBe(`${f.transcript.join("\n")}\n`)
      // The final record is the real run's terminal status.
      expect(r.store.all()[0]?.status).toEqual(f.record.status)
    }
  })

  test("split lines (mid-line, mid-UTF-8 appends) read the same as whole lines", () => {
    const f = loadLaneFixture("notice")
    const whole = createFleetReplay({ sessionsDir: join(dir, "a"), leadSid: LEAD, fixtures: [f] })
    const split = createFleetReplay({
      sessionsDir: join(dir, "b"),
      leadSid: LEAD,
      fixtures: [f],
      splitLines: true,
    })
    const ra = streamReader()
    const rb = streamReader()
    const seen: unknown[] = []
    for (let e = split.step(); e; e = split.step()) {
      const s = rb(split.workers[0]?.streamPath ?? "")
      if (s) seen.push(streamProgress(s))
    }
    whole.stepAll()
    const a = ra(whole.workers[0]?.streamPath ?? "")
    const b = rb(split.workers[0]?.streamPath ?? "")
    expect(a && streamProgress(a)).toEqual(b && streamProgress(b))
    expect(split.events.length).toBeGreaterThan(whole.events.length)
    expect(seen.length).toBeGreaterThan(0)
  })

  test("a fleet of six: ids A1..A6, the widget renders, all end terminal", () => {
    const r = createFleetReplay({
      sessionsDir: dir,
      leadSid: LEAD,
      fixtures: loadLaneFixtures(),
      startOffsetsMs: [0, 1000, 2000, 3000, 4000, 5000],
    })
    let sawSix = false
    let widget: string | null = null
    for (let e = r.step(); e; e = r.step()) {
      const records = r.store.all()
      if (records.length === 6 && records.every((x) => x.status.kind === "running")) {
        sawSix = true
        widget = renderWidget(records, { ansi: false, tick: 0, nowMs: e.at, leadSid: LEAD })
      }
    }
    expect(sawSix).toBe(true)
    expect(widget).toContain("A6")
    expect(r.store.all().map((x) => String(x.id))).toEqual(["A1", "A2", "A3", "A4", "A5", "A6"])
    expect(r.store.all().map((x) => x.status.kind)).toEqual([
      "done",
      "done",
      "failed",
      "stopped",
      "incomplete",
      "incomplete",
    ])
    expect(r.store.filePath()).toBe(join(dir, `${LEAD}.subagents.jsonl`))
  })

  test("run at 1x and 10x waits the recorded gaps on an injected clock", async () => {
    const f = loadLaneFixture("quick-explorer")
    const total = (() => {
      const r = createFleetReplay({ sessionsDir: join(dir, "t"), leadSid: LEAD, fixtures: [f] })
      return r.events.at(-1)?.at ?? 0
    })()
    expect(total).toBeGreaterThan(10_000)
    for (const speed of [1, 10]) {
      const clock = manualClock(1_000)
      const r = createFleetReplay({
        sessionsDir: join(dir, `s${speed}`),
        leadSid: LEAD,
        fixtures: [f],
      })
      const n = await r.run({ speed, clock })
      expect(n).toBe(r.events.length)
      expect(r.done).toBe(true)
      const waited = clock.sleeps.reduce((a, b) => a + b, 0)
      expect(Math.abs(waited - total / speed)).toBeLessThan(1)
      expect(clock.now()).toBeCloseTo(1_000 + total / speed, 3)
    }
  })

  test("run caps long gaps, stops on abort, and rebases times to now", async () => {
    const f = loadLaneFixture("stalled")
    const clock = manualClock(5_000_000)
    const ac = new AbortController()
    const r = createFleetReplay({
      sessionsDir: dir,
      leadSid: LEAD,
      fixtures: [f],
      rebaseToMs: clock.now(),
    })
    let applied = 0
    await r.run({
      clock,
      maxGapMs: 2_000,
      onEvent: () => {
        applied++
        if (applied === 5) ac.abort()
      },
      signal: ac.signal,
    })
    expect(applied).toBe(5)
    expect(r.done).toBe(false)
    expect(Math.max(...clock.sleeps)).toBeLessThanOrEqual(2_000)
    await r.run({ clock, maxGapMs: 2_000 })
    expect(r.done).toBe(true)
    const first = JSON.parse(
      readFileSync(r.workers[0]?.streamPath ?? "", "utf-8").split("\n")[0] ?? "",
    )
    expect(first.ts).toBeGreaterThanOrEqual(5_000_000)
    expect(first.ts).toBeLessThan(5_000_000 + 60_000)
    const rec = r.store.all()[0]
    expect(Date.parse(rec?.spawnedAt ?? "")).toBe(5_000_000)
  })
})

describe("fixture scrub check", () => {
  const files = readdirSync(LANE_FIXTURES_DIR)
  /** Fixtures, their README and the goldens made from them. */
  const scanned = [
    ...files.map((f) => join(LANE_FIXTURES_DIR, f)),
    ...readdirSync(GOLDENS).map((f) => join(GOLDENS, f)),
  ]

  test("every fixture has its three files and the README lists it", () => {
    const readme = readFileSync(join(LANE_FIXTURES_DIR, "README.md"), "utf-8")
    for (const name of Object.keys(LANE_FIXTURES)) {
      for (const suffix of [".stream.ndjson", ".jsonl", ".fleet.jsonl"]) {
        expect(files).toContain(`${name}${suffix}`)
      }
      expect(readme).toContain(`\`${name}\``)
    }
  })

  test("the user-name needle hits a real path or address and skips an ordinary word", () => {
    const re = userNameRe("runner")
    expect(re?.test("/Users/runner/work/x")).toBe(true)
    expect(re?.test("/home/runner/x")).toBe(true)
    expect(re?.test("C:\\Users\\runner\\x")).toBe(true)
    expect(re?.test("mail runner@example.test")).toBe(true)
    expect(re?.test("mail me@runner.test")).toBe(false)
    expect(re?.test("the runner uses it for stage plugin ids")).toBe(false)
    expect(userNameRe("ab")).toBeNull()
  })

  test("no fixture holds a home path, user name, key, bearer, api_key or email", () => {
    const user = process.env.USER ?? ""
    const userRe = userNameRe(user)
    expect(scanned.length).toBeGreaterThanOrEqual(25)
    for (const file of scanned) {
      const text = readFileSync(file, "utf-8")
      const hits: string[] = []
      for (const needle of ["/Users/", ["gas", "ton"].join(""), "sk-", "Bearer ", "api_key"]) {
        if (text.includes(needle)) hits.push(needle)
      }
      // The user name counts only as a path segment or an address part. A bare
      // match fails on a runner whose USER is an ordinary word ("runner").
      if (userRe?.test(text)) hits.push("$USER")
      if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/.test(text)) {
        hits.push("email")
      }
      for (const l of findLeaks(text)) hits.push(`${l.rule}@${l.line}`)
      // Only the rule names reach the failure text, never the matched value.
      expect({ file, hits }).toEqual({ file, hits: [] })
    }
  })

  test("every fixture line is valid JSON", () => {
    for (const file of files.filter((f) => f.endsWith(".jsonl") || f.endsWith(".ndjson"))) {
      const lines = readFileSync(join(LANE_FIXTURES_DIR, file), "utf-8").split("\n")
      expect(lines.at(-1)).toBe("")
      for (const l of lines.slice(0, -1)) expect(() => JSON.parse(l)).not.toThrow()
    }
  })

  test("scrubString replaces paths, names, secrets and keeps the uuid prefix", () => {
    const key = ["sk", "ant", "abcdefghijklmnop1234"].join("-")
    const s = scrubString(
      `cd /Users/alice/x && curl -H "Authorization: Bearer abc.def" ${key} ` +
        "mail alice@example.com id 63411e36-0000-4000-8000-9a45c3456ec4 api_key=zzzzzzzz",
      { userNames: ["alice"] },
    )
    expect(s).toContain("/home/user/x")
    expect(s).toContain("63411e36-0000-4000-8000-000000000000")
    expect(findLeaks(s)).toEqual([])
    expect(s).not.toContain("alice")
    expect(s).not.toContain("abcdefghijklmnop")
  })

  test("scrubJsonLine keeps valid JSON, drops a broken line, clips long text", () => {
    const out = scrubJsonLine(JSON.stringify({ a: "/Users/bob/f", b: "x".repeat(50) }), {
      clipChars: 20,
    })
    expect(JSON.parse(out ?? "")).toEqual({
      a: "/home/user/f",
      b: `${"x".repeat(20)}…[clipped 30 chars]`,
    })
    expect(scrubJsonLine("{not json")).toBeUndefined()
  })
})
