/** Tests for the wait notice: the pinned text, the wait time format, and the rules for how often. */

import { describe, expect, it } from "bun:test"

import type { StatusFields } from "@minimal-agent/core/sdk/events"

import {
  createWaitNoticer,
  formatWait,
  LONG_WAIT_MS,
  WAIT_NOTICE_MIN_MS,
  waitNoticeFor,
} from "./wait-notice.ts"

const quota = (over: Partial<StatusFields> = {}): StatusFields => ({
  phase: "waiting_for_quota",
  attempt: 2,
  nextDelayMs: 8_837_200,
  resetAt: Date.UTC(2026, 10, 18, 3, 15, 0),
  cause: "rate_limit_error",
  ...over,
})
const retry = (over: Partial<StatusFields> = {}): StatusFields => ({
  phase: "retrying",
  attempt: 3,
  nextDelayMs: 45_000,
  cause: "network_error",
  ...over,
})

describe("formatWait", () => {
  const cases: [number, string][] = [
    [1, "1 s"],
    [999, "1 s"],
    [45_000, "45 s"],
    [59_001, "1 min"],
    [60_000, "1 min"],
    [61_000, "2 min"],
    [3_540_000, "59 min"],
    [3_600_000, "1 h"],
    [8_837_200, "2 h 28 min"],
    [7_200_000, "2 h"],
  ]
  for (const [ms, text] of cases) {
    it(`${ms} ms is "${text}"`, () => expect(formatWait(ms)).toBe(text))
  }
})

describe("waitNoticeFor (pinned text)", () => {
  it("a quota wait: a warning with the cause, the wait, the reset time and the try number", () => {
    expect(waitNoticeFor(quota())).toEqual({
      severity: "warning",
      title: "Waiting for the provider quota",
      description:
        "[wait] The provider quota is full (rate_limit_error). The session tries again in 2 h 28 min, at 2026-11-18T03:15:00Z (try 2). To continue now, change the provider or the model.",
    })
  })

  it("a quota wait with no reset time has no time of day", () => {
    expect(waitNoticeFor(quota({ resetAt: undefined }))?.description).toBe(
      "[wait] The provider quota is full (rate_limit_error). The session tries again in 2 h 28 min (try 2). To continue now, change the provider or the model.",
    )
  })

  it("a reset time that is not a valid time is left out", () => {
    expect(waitNoticeFor(quota({ resetAt: Number.NaN }))?.description).not.toContain(", at ")
  })

  it("a retry wait: an info notice", () => {
    expect(waitNoticeFor(retry())).toEqual({
      severity: "info",
      title: "Waiting to retry",
      description:
        "[wait] The request had an error (network_error). The session tries again in 45 s (try 3). To continue now, change the provider or the model.",
    })
  })

  it("a retry wait of a minute or more is a warning (a provider that says: retry after one hour)", () => {
    expect(waitNoticeFor(retry({ nextDelayMs: LONG_WAIT_MS - 1 }))?.severity).toBe("info")
    expect(waitNoticeFor(retry({ nextDelayMs: LONG_WAIT_MS }))?.severity).toBe("warning")
    expect(waitNoticeFor(retry({ nextDelayMs: 3_600_000, cause: "rate_limit_error" }))).toEqual({
      severity: "warning",
      title: "Waiting to retry",
      description:
        "[wait] The request had an error (rate_limit_error). The session tries again in 1 h (try 3). To continue now, change the provider or the model.",
    })
  })

  it("no cause is the word error, and no attempt number leaves the try number out", () => {
    expect(waitNoticeFor({ phase: "retrying", nextDelayMs: 20_000 })?.description).toBe(
      "[wait] The request had an error (error). The session tries again in 20 s. To continue now, change the provider or the model.",
    )
  })

  it("a phase that is not a wait, or a status with no wait time, gives nothing", () => {
    const phases = ["sending", "receiving", "running_tool", "waiting_for_host"] as const
    for (const phase of phases)
      expect(waitNoticeFor({ phase, nextDelayMs: 99_000 })).toBeUndefined()
    expect(waitNoticeFor({ phase: "retrying" })).toBeUndefined()
    expect(waitNoticeFor(retry({ nextDelayMs: 0 }))).toBeUndefined()
    expect(waitNoticeFor(retry({ nextDelayMs: Number.NaN }))).toBeUndefined()
  })
})

describe("createWaitNoticer (how often)", () => {
  it("a wait shorter than the minimum gives no notice", () => {
    const n = createWaitNoticer()
    expect(n.notice(retry({ nextDelayMs: WAIT_NOTICE_MIN_MS - 1 }))).toBeUndefined()
    expect(n.notice(quota({ nextDelayMs: WAIT_NOTICE_MIN_MS - 1 }))).toBeUndefined()
    expect(n.notice(retry({ nextDelayMs: WAIT_NOTICE_MIN_MS }))).toBeDefined()
  })

  it("the same wait reported two times gives one notice", () => {
    const n = createWaitNoticer()
    expect(n.notice(quota())).toBeDefined()
    expect(n.notice(quota())).toBeUndefined()
  })

  it("each quota wait gives a notice", () => {
    const n = createWaitNoticer()
    expect(n.notice(quota({ attempt: 2 }))).toBeDefined()
    expect(n.notice(quota({ attempt: 3 }))).toBeDefined()
  })

  it("retries: the first long wait, then only a wait of the repeat time or more", () => {
    const n = createWaitNoticer()
    expect(n.notice(retry({ attempt: 2, nextDelayMs: 2_000 }))).toBeUndefined()
    expect(n.notice(retry({ attempt: 3, nextDelayMs: 15_000 }))).toBeDefined()
    expect(n.notice(retry({ attempt: 4, nextDelayMs: 30_000 }))).toBeUndefined()
    expect(n.notice(retry({ attempt: 5, nextDelayMs: LONG_WAIT_MS - 1 }))).toBeUndefined()
    expect(n.notice(retry({ attempt: 6, nextDelayMs: LONG_WAIT_MS }))).toBeDefined()
  })

  it("a quota wait after a retry notice still gives a notice", () => {
    const n = createWaitNoticer()
    expect(n.notice(retry({ attempt: 2 }))).toBeDefined()
    expect(n.notice(quota({ attempt: 3 }))?.title).toBe("Waiting for the provider quota")
  })

  it("reset: the next prompt reports its first wait again", () => {
    const n = createWaitNoticer()
    expect(n.notice(retry({ attempt: 2 }))).toBeDefined()
    expect(n.notice(retry({ attempt: 3 }))).toBeUndefined()
    n.reset()
    expect(n.notice(retry({ attempt: 2 }))).toBeDefined()
  })
})
