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
  { kind: "model_adopt_failed", severity: "warn", model: "a", requested: "z", reason: "r" },
  { kind: "stop_hook_capped", severity: "warn", cap: 3 },
]

/**
 * Pinned ACP descriptions. The expected strings are literal on purpose: the
 * plugin owns its text, so this test must not import it from core.
 */
const PINNED_TEXT: readonly { name: string; notice: TurnNotice; text: string }[] = [
  {
    name: "refusal bare",
    notice: { kind: "refusal", severity: "error", category: null, message: null } as TurnNotice,
    text: "[refusal] The provider's safety layer ended the response. The reply above (if any) is incomplete; rephrasing the request usually gets past a false positive.",
  },
  {
    name: "refusal category only",
    notice: { kind: "refusal", severity: "error", category: "cat", message: null } as TurnNotice,
    text: "[refusal] The provider's safety layer ended the response (cat). The reply above (if any) is incomplete; rephrasing the request usually gets past a false positive.",
  },
  {
    name: "refusal message only",
    notice: { kind: "refusal", severity: "error", category: null, message: "why" } as TurnNotice,
    text: "[refusal] The provider's safety layer ended the response \u2014 why. The reply above (if any) is incomplete; rephrasing the request usually gets past a false positive.",
  },
  {
    name: "refusal category and message",
    notice: { kind: "refusal", severity: "error", category: "cat", message: "why" } as TurnNotice,
    text: "[refusal] The provider's safety layer ended the response (cat) \u2014 why. The reply above (if any) is incomplete; rephrasing the request usually gets past a false positive.",
  },
  {
    name: "content_filter bare",
    notice: {
      kind: "content_filter",
      severity: "error",
      category: null,
      message: null,
    } as TurnNotice,
    text: "[content filter] The provider's safety layer ended the response. The reply above (if any) is incomplete; rephrasing the request usually gets past a false positive.",
  },
  {
    name: "content_filter category and message",
    notice: {
      kind: "content_filter",
      severity: "error",
      category: "x",
      message: "y",
    } as TurnNotice,
    text: "[content filter] The provider's safety layer ended the response (x) \u2014 y. The reply above (if any) is incomplete; rephrasing the request usually gets past a false positive.",
  },
  {
    name: "max_tokens_salvaged",
    notice: { kind: "max_tokens_salvaged", severity: "warn" } as TurnNotice,
    text: "[max_tokens] Response hit the max_tokens ceiling mid tool-call; salvaged the in-flight call and continuing.",
  },
  {
    name: "max_tokens_continuing",
    notice: { kind: "max_tokens_continuing", severity: "warn", attempt: 2, cap: 5 } as TurnNotice,
    text: "[max_tokens] Response hit the max_tokens ceiling; auto-continuing (2/5).",
  },
  {
    name: "max_tokens_capped",
    notice: { kind: "max_tokens_capped", severity: "warn", cap: 5 } as TurnNotice,
    text: "[max_tokens] Response hit the max_tokens ceiling 5 times in a row; stopping. Consider narrowing the request or raising max_tokens.",
  },
  {
    name: "reflection_ack one, no reason",
    notice: {
      kind: "reflection_ack",
      severity: "info",
      silenceFor: 1,
      reason: "",
      fromToolFallback: false,
    } as TurnNotice,
    text: "reflection ack: silencing next 1 checkpoint",
  },
  {
    name: "reflection_ack one, reason",
    notice: {
      kind: "reflection_ack",
      severity: "info",
      silenceFor: 1,
      reason: "busy",
      fromToolFallback: false,
    } as TurnNotice,
    text: "reflection ack: silencing next 1 checkpoint \u2014 busy",
  },
  {
    name: "reflection_ack many, no reason",
    notice: {
      kind: "reflection_ack",
      severity: "info",
      silenceFor: 3,
      reason: "",
      fromToolFallback: false,
    } as TurnNotice,
    text: "reflection ack: silencing next 3 checkpoints",
  },
  {
    name: "reflection_ack many, reason",
    notice: {
      kind: "reflection_ack",
      severity: "info",
      silenceFor: 3,
      reason: "busy",
      fromToolFallback: false,
    } as TurnNotice,
    text: "reflection ack: silencing next 3 checkpoints \u2014 busy",
  },
  {
    name: "reflection_ack tool fallback",
    notice: {
      kind: "reflection_ack",
      severity: "info",
      silenceFor: 2,
      reason: "r",
      fromToolFallback: true,
    } as TurnNotice,
    text: "reflection ack: silencing next 2 checkpoints \u2014 r (from tool_use fallback)",
  },
  {
    name: "reflection_ack tool fallback, no reason",
    notice: {
      kind: "reflection_ack",
      severity: "info",
      silenceFor: 1,
      reason: "",
      fromToolFallback: true,
    } as TurnNotice,
    text: "reflection ack: silencing next 1 checkpoint (from tool_use fallback)",
  },
  {
    name: "stream salvaged singular",
    notice: {
      kind: "stream_interrupted_salvaged",
      severity: "warn",
      completedToolCalls: 1,
    } as TurnNotice,
    text: "[stream] Provider closed the response without a terminal event after 1 complete tool call; salvaged closed tools, discarded partials, and continuing from local state. Do not repeat those tool calls.",
  },
  {
    name: "stream salvaged plural",
    notice: {
      kind: "stream_interrupted_salvaged",
      severity: "warn",
      completedToolCalls: 3,
    } as TurnNotice,
    text: "[stream] Provider closed the response without a terminal event after 3 complete tool calls; salvaged closed tools, discarded partials, and continuing from local state. Do not repeat those tool calls.",
  },
  {
    name: "stream continuing",
    notice: {
      kind: "stream_interrupted_continuing",
      severity: "warn",
      attempt: 1,
      cap: 2,
    } as TurnNotice,
    text: "[stream] Provider closed the response without a terminal event mid-output; auto-continuing from local state (1/2).",
  },
  {
    name: "stream capped",
    notice: { kind: "stream_interrupted_capped", severity: "warn", cap: 4 } as TurnNotice,
    text: "[stream] Provider closed the response without a terminal event 4 times in a row mid-output; stopping. Partial output above is preserved.",
  },
  {
    name: "ask_denied",
    notice: { kind: "ask_denied", severity: "warn", code: "c", title: "t" } as TurnNotice,
    text: '[ask] No host can answer "t" (c) in this run; denied the ask and sent the request unchanged.',
  },
  {
    name: "model_adopted no reset",
    notice: {
      kind: "model_adopted",
      severity: "info",
      from: "a",
      to: "b",
      effortReset: false,
      effortFrom: null,
    } as TurnNotice,
    text: '[model] Adopted model "b" (was "a").',
  },
  {
    name: "model_adopted effort reset",
    notice: {
      kind: "model_adopted",
      severity: "info",
      from: "a",
      to: "b",
      effortReset: true,
      effortFrom: "high",
    } as TurnNotice,
    text: '[model] Adopted model "b" (was "a") (effort reset from "high").',
  },
  {
    name: "model_adopt_failed",
    notice: {
      kind: "model_adopt_failed",
      severity: "warn",
      model: "a",
      requested: "z",
      reason: "unknown model",
    } as TurnNotice,
    text: '[model] Could not adopt model "z" (unknown model); kept "a".',
  },
  {
    name: "stop_hook_capped",
    notice: { kind: "stop_hook_capped", severity: "warn", cap: 3 } as TurnNotice,
    text: "[stop hook] A turn.willStop hook blocked the stop more than 3 times in a row; ended the turn.",
  },
]

describe("notice description text", () => {
  it("covers every notice kind", () => {
    const kinds = new Set(PINNED_TEXT.map((c) => c.notice.kind))
    for (const n of SAMPLES) expect(kinds.has(n.kind)).toBe(true)
  })
  for (const c of PINNED_TEXT) {
    it(`pins the description: ${c.name}`, () => {
      expect(toAcpNotice(c.notice).description).toBe(c.text)
    })
  }
})

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

describe("stop_hook_capped", () => {
  const capped = toAcpNotice({ kind: "stop_hook_capped", severity: "warn", cap: 3 })

  it("maps to a warning notice with a clear title", () => {
    const u = noticeUpdate(capped, { clientNotices: true, fallbackMessageId: "n1" })
    expect(u).toEqual({
      sessionUpdate: "notice",
      severity: "warning",
      title: "Stop hook limit reached",
      description: capped.description,
    })
  })

  it("falls back to an agent_message_chunk without the capability", () => {
    const u = noticeUpdate(capped, { clientNotices: false, fallbackMessageId: "n2" })
    expect(u.sessionUpdate).toBe("agent_message_chunk")
    expect(u.messageId).toBe("n2")
    expect((u.content as { text: string }).text).toContain(capped.description ?? "")
  })
})

describe("model_adopt_failed", () => {
  const failed = toAcpNotice({
    kind: "model_adopt_failed",
    severity: "warn",
    model: "alpha",
    requested: "zeta",
    reason: "unknown model",
  })

  it("maps to a warning notice with a clear title", () => {
    const u = noticeUpdate(failed, { clientNotices: true, fallbackMessageId: "n1" })
    expect(u).toEqual({
      sessionUpdate: "notice",
      severity: "warning",
      title: "Model not changed",
      description: failed.description,
    })
    expect(failed.description).toContain("zeta")
    expect(failed.description).toContain("alpha")
  })

  it("falls back to an agent_message_chunk without the capability", () => {
    const u = noticeUpdate(failed, { clientNotices: false, fallbackMessageId: "n2" })
    expect(u.sessionUpdate).toBe("agent_message_chunk")
    expect(u.messageId).toBe("n2")
    expect((u.content as { text: string }).text).toContain(failed.description ?? "")
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
