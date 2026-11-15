import { describe, expect, it } from "bun:test"

import { probeWorker } from "./spawn.ts"
import {
  activityLines,
  createStreamState,
  feedStream,
  parseStream,
  streamEnded,
  streamFailure,
  streamFinalText,
  streamProgress,
  streamReader,
} from "./stream.ts"

const SID = "2f97d95f-07fa-49ed-957f-5e82855f679a"
const env = (seq: number, ts: number) => `"sessionId":"${SID}","seq":${seq},"ts":${ts}`

/** A real `--output-format stream-json` run (captured), one tool + one answer. */
const COMPLETED = [
  `{"type":"session_started","streamVersion":1,"sessionId":"${SID}","resumedFrom":null,"model":"claude-haiku-4-5","provider":"anthropic","effort":null,"cwd":"/tmp","version":"0.1.0","outputFormat":"stream-json","seq":0,"ts":1000}`,
  `{"type":"turn_started","turn":1,${env(1, 1005)}}`,
  `{"type":"item_started","itemType":"tool_use","id":"toolu_1","label":"Bash","toolName":"Bash","input":{"command":"echo hi"},${env(2, 2000)}}`,
  `{"type":"item_completed","itemType":"tool_use","id":"toolu_1","text":"Bash",${env(3, 2000)}}`,
  `{"type":"tool_result","id":"toolu_1","name":"Bash","isError":false,"inputSummary":"{}","outputSummary":"hi","durationMs":18,${env(4, 2018)}}`,
  `{"type":"turn_completed","turn":1,"stopReason":"tool_use","usage":{"inputTokens":3,"outputTokens":53,"cacheReadTokens":0,"cacheCreationTokens":30896},${env(5, 2019)}}`,
  `{"type":"turn_started","turn":2,${env(6, 2020)}}`,
  `{"type":"text_delta","id":"2:text","text":"Do",${env(7, 2500)}}`,
  `{"type":"text_delta","id":"2:text","text":"ne.",${env(8, 2510)}}`,
  `{"type":"item_started","itemType":"text","id":"2:0",${env(9, 2600)}}`,
  `{"type":"item_completed","itemType":"text","id":"2:0","text":"Done.",${env(10, 2600)}}`,
  `{"type":"turn_completed","turn":2,"stopReason":"end_turn","usage":{"inputTokens":5,"outputTokens":5,"cacheReadTokens":30896,"cacheCreationTokens":96,"reasoningTokens":2},${env(11, 2601)}}`,
  `{"type":"run_finished","outcome":"completed",${env(12, 2602)}}`,
  `{"type":"result","text":"Done.","usage":{"inputTokens":8,"outputTokens":58,"cacheReadTokens":30896,"cacheWriteTokens":30992},"stopReason":"end_turn","outcome":"completed","model":"claude-haiku-4-5","provider":"anthropic","durationMs":2517,${env(13, 2603)}}`,
].join("\n")

/** A real boot failure: the CLI still ends stdout with error + run_finished. */
const BOOT_FAIL = [
  `{"type":"error","message":"effort \\"medium\\" was requested but this model does not support reasoning effort",${env(0, 500)}}`,
  `{"type":"run_finished","outcome":"failed",${env(1, 500)}}`,
].join("\n")

describe("stream parser", () => {
  it("folds a completed run into exact telemetry", () => {
    const s = parseStream(COMPLETED)
    expect(s.model).toBe("claude-haiku-4-5")
    expect(s.provider).toBe("anthropic")
    expect(s.turns).toBe(2)
    expect(s.tools).toBe(1)
    expect(s.toolErrors).toBe(0)
    expect(s.toolMs).toBe(18)
    // last-turn context = 5 + 30896 + 96, output summed across turns
    expect(s.contextTokens).toBe(30997)
    expect(s.outputTokens).toBe(58)
    expect(s.thinkingTokens).toBe(2)
    expect(s.outcome).toBe("completed")
    expect(s.result?.durationMs).toBe(2517)
    expect(streamEnded(s)).toBe(true)
    expect(streamFinalText(s)).toBe("Done.")
    expect(streamFailure(s)).toBeUndefined()
  })

  it("maps to Progress with phase, turns and the resolved model", () => {
    const p = streamProgress(parseStream(COMPLETED))
    expect(p).toMatchObject({
      tools: 1,
      tokens: 30997,
      output: 58,
      thinking: 2,
      lastTool: "Bash",
      turns: 2,
      phase: "finished",
      lastEventAt: 2603,
      model: "claude-haiku-4-5",
    })
    expect(p?.toolErrors).toBeUndefined()
  })

  it("returns no progress for an empty stream (transcript fallback answers)", () => {
    expect(streamProgress(createStreamState())).toBeUndefined()
  })

  it("tracks the in-flight tool and the live text phase", () => {
    const s = createStreamState()
    feedStream(s, `${COMPLETED.split("\n").slice(0, 3).join("\n")}\n`)
    expect(s.phase).toBe("tool")
    expect(s.inFlight).toMatchObject({ name: "Bash", label: "Bash: echo hi", since: 2000 })
    const p = streamProgress(s)
    expect(p?.lastActivity).toBe("Bash: echo hi")
    expect(p?.toolSince).toBe(2000)

    feedStream(s, `${COMPLETED.split("\n").slice(3, 9).join("\n")}\n`)
    expect(s.inFlight).toBeUndefined()
    expect(s.phase).toBe("writing")
    expect(s.liveText).toBe("Done.")
    expect(streamEnded(s)).toBe(false)
  })

  it("counts failed tool calls and lists them in the activity tail", () => {
    const s = parseStream(
      [
        `{"type":"item_started","itemType":"tool_use","id":"t1","toolName":"Read","input":{"file_path":"/nope"},${env(0, 1000)}}`,
        `{"type":"tool_result","id":"t1","name":"Read","isError":true,"outputSummary":"ENOENT: no such file","durationMs":2,${env(1, 1002)}}`,
      ].join("\n"),
    )
    expect(s.toolErrors).toBe(1)
    const lines = activityLines(s)
    expect(lines[0]).toContain("→ Read: /nope")
    expect(lines[1]).toContain("✘ Read failed: ENOENT: no such file")
  })

  it("names the cause of a boot failure structurally", () => {
    const s = parseStream(BOOT_FAIL)
    expect(streamEnded(s)).toBe(true)
    expect(streamFailure(s)).toContain("does not support reasoning effort")
    expect(streamFinalText(s)).toBeUndefined()
  })

  it("treats a paused run with an error as failed (headless: nobody resumes)", () => {
    const s = parseStream(
      [
        `{"type":"error","message":"API 400: bad request","hint":"check the model id","recoverable":false,${env(0, 1)}}`,
        `{"type":"run_finished","outcome":"waiting",${env(1, 2)}}`,
      ].join("\n"),
    )
    expect(streamFailure(s)).toBe("API 400: bad request (hint: check the model id)")
  })

  it("does not call a completed run_finished alone the end (schema retry may follow)", () => {
    const s = parseStream(`{"type":"run_finished","outcome":"completed",${env(0, 1)}}`)
    expect(streamEnded(s)).toBe(false)
  })

  it("skips corrupt and non-JSON lines", () => {
    const s = parseStream(`garbage\n{not json\n${BOOT_FAIL}`)
    expect(s.lines).toBe(2)
  })
})

describe("streamReader (incremental)", () => {
  it("reads only appended bytes, holds partial lines, and resets on shrink", () => {
    let file = ""
    const reads: Array<[number, number]> = []
    const read = streamReader({
      size: () => (file.length === 0 ? null : Buffer.byteLength(file)),
      readRange: (_p, offset, length) => {
        reads.push([offset, length])
        return Buffer.from(file)
          .subarray(offset, offset + length)
          .toString("utf-8")
      },
    })
    expect(read("/s")).toBeUndefined()

    const lines = COMPLETED.split("\n")
    // first half plus a partial line with no newline yet
    file = `${lines.slice(0, 5).join("\n")}\n${lines[5]?.slice(0, 20)}`
    const s1 = read("/s")
    expect(s1?.tools).toBe(1)
    expect(s1?.lines).toBe(5)

    file = `${lines.join("\n")}\n`
    const s2 = read("/s")
    expect(s2?.lines).toBe(14)
    expect(s2?.result?.text).toBe("Done.")
    // second read started where the first stopped (after the 5th newline)
    expect(reads[1]?.[0]).toBe(Buffer.byteLength(`${lines.slice(0, 5).join("\n")}\n`))

    // no growth → no read
    read("/s")
    expect(reads.length).toBe(2)

    // file rewritten smaller → fresh state
    file = `${BOOT_FAIL}\n`
    const s3 = read("/s")
    expect(s3?.lines).toBe(2)
    expect(s3?.error?.message).toContain("reasoning effort")
  })
})

describe("probeWorker with a stream", () => {
  const target = {
    pid: 7,
    resultPath: "/tmp/r.json",
    transcriptPath: "/tmp/t.jsonl",
    logPath: "/tmp/w.log",
    streamPath: "/tmp/w.stream.ndjson",
  }
  const never = (what: string) => () => {
    throw new Error(`should not ${what}`)
  }

  it("uses stream progress over the transcript", () => {
    const probe = probeWorker(target, {
      pidAlive: () => true,
      readResult: () => undefined,
      readStream: () => parseStream(COMPLETED.split("\n").slice(0, 3).join("\n")),
      readProgress: never("parse the transcript"),
    })
    expect(probe.alive).toBe(true)
    expect(probe.progress?.phase).toBe("tool")
    expect(probe.runEnded).toBeUndefined()
  })

  it("falls back to the transcript when no stream exists (old worker)", () => {
    const probe = probeWorker(target, {
      pidAlive: () => true,
      readResult: () => undefined,
      readStream: () => undefined,
      readProgress: () => ({ tools: 3, tokens: 10 }),
    })
    expect(probe.progress).toEqual({ tools: 3, tokens: 10 })
  })

  it("distills the exact final answer from the result line, even while the pid lingers", () => {
    const probe = probeWorker(target, {
      pidAlive: () => true,
      readResult: () => undefined,
      readStream: () => parseStream(COMPLETED),
      readFinalText: never("parse the transcript"),
      readCrash: never("mine the log"),
    })
    expect(probe.alive).toBe(true)
    expect(probe.runEnded).toBe(true)
    expect(probe.distilled).toBe("Done.")
    expect(probe.durationMs).toBe(2517)
  })

  it("reports a stream failure without mining the log", () => {
    const probe = probeWorker(target, {
      pidAlive: () => false,
      readResult: () => undefined,
      readStream: () => parseStream(BOOT_FAIL),
      readCrash: never("mine the log"),
    })
    expect(probe.runFailed).toContain("reasoning effort")
    expect(probe.crash).toBeUndefined()
  })

  it("still mines the log when the binary never wrote a stream line", () => {
    const probe = probeWorker(target, {
      pidAlive: () => false,
      readResult: () => undefined,
      readStream: () => createStreamState(),
      readCrash: () => "fatal: cannot start",
    })
    expect(probe.crash).toBe("fatal: cannot start")
  })
})
