import { describe, expect, it } from "bun:test"

import type { TurnNotice } from "@minimal-agent/core/sdk/turn-notice"

import {
  clientSupportsNotices,
  noticeTitle,
  noticeUpdate,
  toAcpNotice,
  toAcpSeverity,
} from "./notices.ts"

/** One sample of every core notice kind. */
const SAMPLES: readonly TurnNotice[] = [
  { kind: "refusal", severity: "error", category: null, message: null },
  { kind: "content_filter", severity: "error", category: "x", message: "y" },
  { kind: "max_tokens_salvaged", severity: "warn" },
  { kind: "max_tokens_continuing", severity: "warn", attempt: 1, cap: 5 },
  { kind: "max_tokens_capped", severity: "warn", cap: 5 },
  { kind: "reflection_ack", severity: "info", silenceFor: 2, reason: "r", fromToolFallback: false },
  { kind: "stream_interrupted_salvaged", severity: "warn", completedToolCalls: 1 },
  { kind: "stream_interrupted_continuing", severity: "warn", attempt: 1, cap: 1 },
  { kind: "stream_interrupted_capped", severity: "warn", cap: 1 },
  { kind: "ask_denied", severity: "warn", code: "c", title: "t" },
  {
    kind: "model_adopted",
    severity: "info",
    from: "a",
    to: "b",
    effortReset: false,
    effortFrom: null,
  },
]

describe("notice severity", () => {
  it("maps warn to warning", () => expect(toAcpSeverity("warn")).toBe("warning"))
  it("maps info to info", () => expect(toAcpSeverity("info")).toBe("info"))
  it("maps error to error", () => expect(toAcpSeverity("error")).toBe("error"))
  it("never sends a raw warn", () => {
    for (const n of SAMPLES) expect(toAcpNotice(n).severity).not.toBe("warn" as never)
  })
})

describe("notice title", () => {
  it("is non-empty for every core notice kind", () => {
    for (const n of SAMPLES) {
      expect(noticeTitle(n).length).toBeGreaterThan(0)
      expect(toAcpNotice(n).title.length).toBeGreaterThan(0)
    }
  })
  it("refuses to encode an empty title", () => {
    expect(() =>
      noticeUpdate(
        { severity: "info", title: "" },
        { clientNotices: true, fallbackMessageId: "n" },
      ),
    ).toThrow()
  })
})

describe("notice update", () => {
  const notice = toAcpNotice({ kind: "max_tokens_capped", severity: "warn", cap: 5 })

  it("sends a notice update when the client advertised session.notices", () => {
    const u = noticeUpdate(notice, { clientNotices: true, fallbackMessageId: "n1" })
    expect(u).toEqual({
      sessionUpdate: "notice",
      severity: "warning",
      title: "Output limit reached",
      description: notice.description,
    })
  })

  it("falls back to an agent_message_chunk without the capability", () => {
    const u = noticeUpdate(notice, { clientNotices: false, fallbackMessageId: "n1" })
    expect(u.sessionUpdate).toBe("agent_message_chunk")
    expect(u.messageId).toBe("n1")
    expect((u.content as { text: string }).text).toContain(notice.description ?? "")
  })
})

describe("clientSupportsNotices", () => {
  it("is true only for an object at clientCapabilities.session.notices", () => {
    expect(clientSupportsNotices({ clientCapabilities: { session: { notices: {} } } })).toBe(true)
    expect(clientSupportsNotices({ clientCapabilities: { session: { notices: null } } })).toBe(
      false,
    )
    expect(clientSupportsNotices({ clientCapabilities: { session: {} } })).toBe(false)
    expect(clientSupportsNotices({ clientCapabilities: {} })).toBe(false)
    expect(clientSupportsNotices({})).toBe(false)
    expect(clientSupportsNotices(undefined)).toBe(false)
  })
})
