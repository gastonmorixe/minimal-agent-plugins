import { describe, expect, test } from "bun:test"

import {
  applyDownloadEvent,
  browserWsUrl,
  buildRequest,
  type CdpInbound,
  classifyInbound,
  type DownloadRecord,
  MAX_DOWNLOAD_RECORDS,
  parseDevToolsActivePort,
} from "./protocol.ts"

describe("buildRequest", () => {
  test("omits sessionId when not given", () => {
    expect(buildRequest(1, "Foo.bar", { a: 1 })).toEqual({
      id: 1,
      method: "Foo.bar",
      params: { a: 1 },
    })
  })

  test("defaults params to empty object", () => {
    expect(buildRequest(2, "Foo.baz")).toEqual({ id: 2, method: "Foo.baz", params: {} })
  })

  test("includes sessionId when given", () => {
    expect(buildRequest(3, "Page.enable", {}, "S1")).toEqual({
      id: 3,
      method: "Page.enable",
      params: {},
      sessionId: "S1",
    })
  })
})

describe("parseDevToolsActivePort", () => {
  test("parses port + ws path", () => {
    expect(parseDevToolsActivePort("9222\n/devtools/browser/abc-123\n")).toEqual({
      port: 9222,
      wsPath: "/devtools/browser/abc-123",
    })
  })

  test("trims trailing whitespace and CRs", () => {
    expect(parseDevToolsActivePort("9333\r\n/devtools/browser/x\r\n").port).toBe(9333)
  })

  test("throws on single line", () => {
    expect(() => parseDevToolsActivePort("9222")).toThrow(/expected 2 lines/)
  })

  test("throws on bad port", () => {
    expect(() => parseDevToolsActivePort("nope\n/devtools/browser/x")).toThrow(/bad port/)
  })

  test("throws on non-browser ws path", () => {
    expect(() => parseDevToolsActivePort("9222\n/devtools/page/x")).toThrow(/bad ws path/)
  })
})

describe("browserWsUrl", () => {
  test("uses 127.0.0.1 to avoid DNS + rebind issues", () => {
    expect(browserWsUrl(9222, "/devtools/browser/x")).toBe("ws://127.0.0.1:9222/devtools/browser/x")
  })
})

describe("classifyInbound", () => {
  test("reply with result", () => {
    const m: CdpInbound = { id: 7, result: { ok: true } }
    expect(classifyInbound(m)).toEqual({
      kind: "reply",
      id: 7,
      error: undefined,
      result: { ok: true },
    })
  })

  test("reply with error", () => {
    const m: CdpInbound = { id: 8, error: { code: -32000, message: "boom" } }
    const c = classifyInbound(m)
    expect(c.kind).toBe("reply")
    if (c.kind === "reply") expect(c.error?.message).toBe("boom")
  })

  test("attachedToTarget extracts url + type", () => {
    const m: CdpInbound = {
      method: "Target.attachedToTarget",
      params: { sessionId: "S9", targetInfo: { url: "https://x", type: "iframe" } },
    }
    expect(classifyInbound(m)).toEqual({
      kind: "attached",
      sessionId: "S9",
      url: "https://x",
      targetType: "iframe",
    })
  })

  test("detachedFromTarget", () => {
    const m: CdpInbound = { method: "Target.detachedFromTarget", params: { sessionId: "S9" } }
    expect(classifyInbound(m)).toEqual({ kind: "detached", sessionId: "S9" })
  })

  test("downloadWillBegin", () => {
    const m: CdpInbound = {
      method: "Browser.downloadWillBegin",
      params: { guid: "g1", url: "data:,x", suggestedFilename: "a.txt" },
    }
    expect(classifyInbound(m)).toEqual({
      kind: "downloadBegin",
      guid: "g1",
      url: "data:,x",
      file: "a.txt",
    })
  })

  test("downloadProgress", () => {
    const m: CdpInbound = {
      method: "Browser.downloadProgress",
      params: { guid: "g1", state: "completed" },
    }
    expect(classifyInbound(m)).toEqual({
      kind: "downloadProgress",
      guid: "g1",
      state: "completed",
    })
  })

  test("unknown event is ignored", () => {
    expect(classifyInbound({ method: "Network.requestWillBeSent" })).toEqual({ kind: "ignored" })
  })
})

describe("applyDownloadEvent", () => {
  test("begin appends a record in begin state", () => {
    const next = applyDownloadEvent([], { kind: "downloadBegin", guid: "g1", url: "u", file: "f" })
    expect(next).toEqual([{ guid: "g1", url: "u", file: "f", state: "begin" }])
  })

  test("progress updates matching guid only", () => {
    const start: DownloadRecord[] = [
      { guid: "g1", url: "u1", file: "f1", state: "begin" },
      { guid: "g2", url: "u2", file: "f2", state: "begin" },
    ]
    const next = applyDownloadEvent(start, {
      kind: "downloadProgress",
      guid: "g1",
      state: "completed",
    })
    expect(next[0]?.state).toBe("completed")
    expect(next[1]?.state).toBe("begin")
  })

  test("progress for unknown guid is a no-op", () => {
    const start: DownloadRecord[] = [{ guid: "g1", url: "u", file: "f", state: "begin" }]
    expect(
      applyDownloadEvent(start, { kind: "downloadProgress", guid: "zzz", state: "completed" }),
    ).toEqual(start)
  })

  test("non-download events pass records through unchanged", () => {
    const start: DownloadRecord[] = [{ guid: "g1", url: "u", file: "f", state: "begin" }]
    expect(applyDownloadEvent(start, { kind: "ignored" })).toBe(start)
  })

  test("begin caps the list at MAX_DOWNLOAD_RECORDS, keeping the most recent", () => {
    let records: DownloadRecord[] = []
    const total = MAX_DOWNLOAD_RECORDS + 50
    for (let i = 0; i < total; i++) {
      records = applyDownloadEvent(records, {
        kind: "downloadBegin",
        guid: `g${i}`,
        url: "u",
        file: "f",
      })
    }
    expect(records.length).toBe(MAX_DOWNLOAD_RECORDS)
    // Oldest evicted, newest retained.
    expect(records[0]?.guid).toBe("g50")
    expect(records.at(-1)?.guid).toBe(`g${total - 1}`)
  })
})
