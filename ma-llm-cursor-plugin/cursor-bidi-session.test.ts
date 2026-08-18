/** Regression tests for bidi session lifecycle and replacement-safe cleanup. */

import { afterEach, describe, expect, test } from "bun:test"

import type { CursorBidiWire } from "./connect/bidi-wire.ts"
import type { CursorBidiSession } from "./cursor-bidi-session.ts"
import {
  clearCursorBidiSession,
  getCursorBidiSession,
  resetCursorBidiSessionsForTests,
  setCursorBidiSession,
} from "./cursor-bidi-session.ts"

function fakeSession(closed = false): CursorBidiSession {
  const wire: CursorBidiWire = {
    writeProto() {},
    close() {},
    isClosed: () => closed,
    async *envelopes() {},
  }
  return {
    wire,
    envelopeGen: wire.envelopes(),
    translator: undefined as never,
    conversationId: "conversation",
    pendingExec: null,
    blobStore: new Map(),
  }
}

describe("cursor bidi session lifecycle", () => {
  test("clears a closed session before continuation lookup", () => {
    const session = fakeSession(true)
    setCursorBidiSession("session", session)

    const current = getCursorBidiSession("session")
    expect(current?.wire.isClosed()).toBe(true)
    clearCursorBidiSession("session", current)
    expect(getCursorBidiSession("session")).toBeUndefined()
  })

  test("does not clear a replacement when stale cleanup races", () => {
    const stale = fakeSession(true)
    const replacement = fakeSession(false)
    setCursorBidiSession("session", stale)
    setCursorBidiSession("session", replacement)

    clearCursorBidiSession("session", stale)
    expect(getCursorBidiSession("session")).toBe(replacement)

    clearCursorBidiSession("session", replacement)
    expect(getCursorBidiSession("session")).toBeUndefined()
  })

  afterEach(() => {
    resetCursorBidiSessionsForTests()
  })
})
