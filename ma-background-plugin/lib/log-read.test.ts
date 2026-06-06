import { describe, expect, test } from "bun:test"

import { type LogIO, readLog, selectLog, stripAnsi } from "./log-read.ts"

const BIG = 1_000_000

describe("stripAnsi", () => {
  test("removes color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red")
  })
  test("leaves plain text", () => {
    expect(stripAnsi("plain")).toBe("plain")
  })
})

describe("selectLog basics", () => {
  const content = "line1\nline2\nline3\nline4\nline5\n"

  test("counts total lines, drops trailing empty", () => {
    const r = selectLog(content, { maxBytes: BIG })
    expect(r.totalLines).toBe(5)
    expect(r.shownLines).toBe(5)
    expect(r.text).toBe("line1\nline2\nline3\nline4\nline5")
  })

  test("tail keeps last N", () => {
    const r = selectLog(content, { tail: 2, maxBytes: BIG })
    expect(r.text).toBe("line4\nline5")
    expect(r.shownLines).toBe(2)
  })

  test("offset/limit range", () => {
    const r = selectLog(content, { offset: 1, limit: 2, maxBytes: BIG })
    expect(r.text).toBe("line2\nline3")
  })

  test("empty content", () => {
    const r = selectLog("", { maxBytes: BIG })
    expect(r.totalLines).toBe(0)
    expect(r.text).toBe("")
  })
})

describe("selectLog grep", () => {
  const content = "error: bad\ninfo: ok\nerror: worse\nwarn: hmm\n"
  test("filters matching lines", () => {
    const r = selectLog(content, { grep: "error", maxBytes: BIG })
    expect(r.text).toBe("error: bad\nerror: worse")
    expect(r.filtered).toBe(true)
    expect(r.shownLines).toBe(2)
  })
  test("grep then tail", () => {
    const r = selectLog(content, { grep: "error", tail: 1, maxBytes: BIG })
    expect(r.text).toBe("error: worse")
  })
})

describe("selectLog ANSI handling", () => {
  const content = "\x1b[31mred line\x1b[0m\nplain\n"
  test("strips by default", () => {
    const r = selectLog(content, { maxBytes: BIG })
    expect(r.text).toBe("red line\nplain")
  })
  test("raw keeps escapes", () => {
    const r = selectLog(content, { raw: true, maxBytes: BIG })
    expect(r.text).toContain("\x1b[31m")
  })
})

describe("selectLog byte cap keeps the tail", () => {
  test("clips to maxBytes and flags it", () => {
    const content = `${"x".repeat(100)}\n${"y".repeat(100)}\n`
    const r = selectLog(content, { maxBytes: 50 })
    expect(r.clippedByBytes).toBe(true)
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(50)
    expect(r.text.endsWith("y")).toBe(true) // tail preserved
  })
})

describe("readLog with injected IO", () => {
  function io(files: Record<string, string>): LogIO {
    return {
      readFile: (p) => files[p],
      size: (p) => (p in files ? Buffer.byteLength(files[p], "utf8") : undefined),
    }
  }

  test("absent file -> exists false", () => {
    const r = readLog("/nope.log", { maxBytes: BIG }, io({}))
    expect(r.exists).toBe(false)
    expect(r.byteCursor).toBe(0)
    expect(r.text).toBe("")
  })

  test("reads whole file and reports byteCursor", () => {
    const files = { "/a.log": "one\ntwo\n" }
    const r = readLog("/a.log", { maxBytes: BIG }, io(files))
    expect(r.exists).toBe(true)
    expect(r.text).toBe("one\ntwo")
    expect(r.byteCursor).toBe(Buffer.byteLength(files["/a.log"], "utf8"))
  })

  test("since cursor returns only the new tail", () => {
    const files = { "/a.log": "AAAA\nBBBB\n" }
    const since = Buffer.byteLength("AAAA\n", "utf8")
    const r = readLog("/a.log", { maxBytes: BIG, since }, io(files))
    expect(r.text).toBe("BBBB")
    expect(r.byteCursor).toBe(Buffer.byteLength(files["/a.log"], "utf8"))
  })

  test("since at or past end -> empty new content", () => {
    const files = { "/a.log": "AAAA\n" }
    const r = readLog("/a.log", { maxBytes: BIG, since: 9999 }, io(files))
    expect(r.text).toBe("")
  })
})
