import { describe, expect, test } from "bun:test"

import { buildArgv, parseEnv } from "./macos-say.ts"

describe("buildArgv", () => {
  test("always reads text from stdin via -f -", () => {
    expect(buildArgv({})).toEqual(["-f", "-"])
  })

  test("adds -v when a voice is set", () => {
    expect(buildArgv({ voice: "Samantha" })).toEqual(["-v", "Samantha", "-f", "-"])
  })

  test("adds -r when a positive rate is set", () => {
    expect(buildArgv({ rate: 180 })).toEqual(["-r", "180", "-f", "-"])
  })

  test("floors a fractional rate", () => {
    expect(buildArgv({ rate: 199.9 })).toEqual(["-r", "199", "-f", "-"])
  })

  test("ignores a non-positive or non-finite rate", () => {
    expect(buildArgv({ rate: 0 })).toEqual(["-f", "-"])
    expect(buildArgv({ rate: -5 })).toEqual(["-f", "-"])
    expect(buildArgv({ rate: Number.NaN })).toEqual(["-f", "-"])
  })

  test("combines voice and rate in order", () => {
    expect(buildArgv({ voice: "Alex", rate: 220 })).toEqual(["-v", "Alex", "-r", "220", "-f", "-"])
  })

  test("never embeds the text in argv", () => {
    // Defensive: there is no text field on the options, and the joined argv
    // must never contain spoken content.
    const argv = buildArgv({ voice: "Samantha", rate: 180 })
    expect(argv.join(" ")).not.toContain("hello")
  })
})

describe("parseEnv", () => {
  test("empty env → empty options", () => {
    expect(parseEnv({})).toEqual({})
  })

  test("reads voice (trimmed)", () => {
    expect(parseEnv({ MA_SPEAK_VOICE: "  Samantha  " })).toEqual({ voice: "Samantha" })
  })

  test("reads a valid rate", () => {
    expect(parseEnv({ MA_SPEAK_RATE: "180" })).toEqual({ rate: 180 })
  })

  test("ignores an invalid rate", () => {
    expect(parseEnv({ MA_SPEAK_RATE: "fast" })).toEqual({})
    expect(parseEnv({ MA_SPEAK_RATE: "-10" })).toEqual({})
    expect(parseEnv({ MA_SPEAK_RATE: "0" })).toEqual({})
  })

  test("ignores empty voice", () => {
    expect(parseEnv({ MA_SPEAK_VOICE: "   " })).toEqual({})
  })
})
