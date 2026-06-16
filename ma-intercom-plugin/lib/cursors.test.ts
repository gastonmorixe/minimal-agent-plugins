import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { advanceCursor, coerceCursor, readCursor, writeCursor, ZERO_CURSOR } from "./cursors.ts"

describe("coerceCursor", () => {
  it("defaults to zero for junk", () => {
    expect(coerceCursor(null)).toEqual(ZERO_CURSOR)
    expect(coerceCursor("x")).toEqual(ZERO_CURSOR)
    expect(coerceCursor({})).toEqual(ZERO_CURSOR)
  })

  it("floors + clamps negatives to zero", () => {
    expect(coerceCursor({ seen: 3.9, woken: -2, read: 5 })).toEqual({ seen: 3, woken: 0, read: 5 })
  })
})

describe("read/write round-trip", () => {
  it("returns zero for a missing file and persists writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "intercom-cursor-"))
    try {
      const path = join(dir, "c.json")
      expect(readCursor(path)).toEqual(ZERO_CURSOR)
      writeCursor(path, { seen: 2, woken: 1, read: 0 })
      expect(readCursor(path)).toEqual({ seen: 2, woken: 1, read: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("advanceCursor — monotonic merge-on-write (lost-update fix)", () => {
  it("takes the max per field and never rolls a sibling back", () => {
    const dir = mkdtempSync(join(tmpdir(), "intercom-cursor-adv-"))
    try {
      const path = join(dir, "c.json")
      // Simulate three independent advancers writing the SAME file:
      advanceCursor(path, { seen: 5 }) // attachment advances seen
      advanceCursor(path, { woken: 3 }) // heartbeat advances woken
      advanceCursor(path, { read: 9 }) // Inbox tool advances read
      expect(readCursor(path)).toEqual({ seen: 5, woken: 3, read: 9 })

      // A stale writer trying to lower a field is ignored (max wins).
      advanceCursor(path, { seen: 2 })
      expect(readCursor(path).seen).toBe(5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
