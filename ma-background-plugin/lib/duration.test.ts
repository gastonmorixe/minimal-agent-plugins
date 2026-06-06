import { describe, expect, test } from "bun:test"

import {
  formatDuration,
  INFINITE_MS,
  ONE_DAY_MS,
  type ParseDurationOptions,
  parseDuration,
} from "./duration.ts"

const base: ParseDurationOptions = {
  defaultMs: 600_000,
  maxMs: ONE_DAY_MS,
  allowInfinite: false,
}

function ms(raw: string | number | undefined, opts: ParseDurationOptions = base): number {
  const r = parseDuration(raw, opts)
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`)
  return r.value.ms
}

describe("parseDuration units", () => {
  test("undefined -> default", () => {
    expect(ms(undefined)).toBe(600_000)
  })
  test("empty string -> default", () => {
    expect(ms("")).toBe(600_000)
  })
  test("bare number string -> seconds", () => {
    expect(ms("90")).toBe(90_000)
  })
  test("numeric input -> seconds", () => {
    expect(ms(45)).toBe(45_000)
  })
  test("seconds suffix", () => {
    expect(ms("30s")).toBe(30_000)
  })
  test("minutes", () => {
    expect(ms("10m")).toBe(600_000)
  })
  test("hours", () => {
    expect(ms("2h")).toBe(7_200_000)
  })
  test("days", () => {
    expect(ms("1d")).toBe(86_400_000)
  })
  test("milliseconds", () => {
    expect(ms("500ms")).toBe(1000) // floored to minMs (1s)
  })
  test("whitespace and case tolerant", () => {
    expect(ms("  2H ")).toBe(7_200_000)
  })
  test("long unit aliases", () => {
    expect(ms("5min")).toBe(300_000)
    expect(ms("3hrs")).toBe(10_800_000)
    // "2days" parses to 172_800_000 but base clamps at one day.
    expect(ms("2days")).toBe(ONE_DAY_MS)
    // with a higher ceiling it is not clamped
    expect(ms("2days", { ...base, maxMs: 10 * ONE_DAY_MS })).toBe(172_800_000)
  })
})

describe("parseDuration clamping", () => {
  test("over max is clamped to max with clamped flag", () => {
    const r = parseDuration("48h", base)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.ms).toBe(ONE_DAY_MS)
      expect(r.value.clamped).toBe(true)
    }
  })
  test("under min floors to 1s, not flagged clamped", () => {
    const r = parseDuration("10ms", base)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.ms).toBe(1000)
      expect(r.value.clamped).toBe(false)
    }
  })
  test("custom minMs is honored", () => {
    expect(ms("1s", { ...base, minMs: 5000 })).toBe(5000)
  })
})

describe("parseDuration infinite gating", () => {
  test("infinite rejected when not allowed", () => {
    for (const tok of ["infinite", "inf", "none", "never", "0"]) {
      const r = parseDuration(tok, base)
      expect(r.ok).toBe(false)
    }
  })
  test("numeric 0 rejected when not allowed", () => {
    expect(parseDuration(0, base).ok).toBe(false)
  })
  test("infinite accepted when allowed", () => {
    const opts = { ...base, allowInfinite: true }
    const r = parseDuration("infinite", opts)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.ms).toBe(INFINITE_MS)
      expect(r.value.infinite).toBe(true)
    }
    expect(ms("0", opts)).toBe(INFINITE_MS)
    expect(ms(0, opts)).toBe(INFINITE_MS)
  })
})

describe("parseDuration errors", () => {
  test("garbage string", () => {
    expect(parseDuration("soon", base).ok).toBe(false)
    expect(parseDuration("10x", base).ok).toBe(false)
    expect(parseDuration("abc", base).ok).toBe(false)
  })
  test("negative number", () => {
    expect(parseDuration(-5, base).ok).toBe(false)
  })
  test("non-finite number", () => {
    expect(parseDuration(Number.POSITIVE_INFINITY, base).ok).toBe(false)
    expect(parseDuration(Number.NaN, base).ok).toBe(false)
  })
})

describe("formatDuration", () => {
  test("formats compactly", () => {
    expect(formatDuration(INFINITE_MS)).toBe("∞")
    expect(formatDuration(500)).toBe("500ms")
    expect(formatDuration(41_000)).toBe("41s")
    expect(formatDuration(600_000)).toBe("10m")
    expect(formatDuration(7_200_000)).toBe("2h")
    expect(formatDuration(86_400_000)).toBe("1d")
  })
})
