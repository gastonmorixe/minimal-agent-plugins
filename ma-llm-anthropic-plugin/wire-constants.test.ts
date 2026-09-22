/**
 * Wire-identity pins for the claude-code mimicry layer.
 *
 * These values are what the Anthropic server sees and validates. A stale
 * VERSION makes the API reject new models with HTTP 400
 * `claude_code_version_too_old`, so the version is pinned as a literal here:
 * bumping it must be a deliberate edit in two places, never an accident.
 *
 * @module llm-anthropic/wire-constants.test
 */

import { createHash } from "node:crypto"

import { describe, expect, it } from "bun:test"

import {
  BUILD_HASH,
  BUILD_TIME,
  buildHashFor,
  GIT_SHA,
  STAINLESS_SDK_VERSION,
  USER_AGENT,
  USER_AGENT_MCP,
  USER_AGENT_OAUTH,
  VERSION,
} from "./wire-constants.ts"

describe("wire constants", () => {
  it("pins the claude-code version the server gates models on", () => {
    // Source: build-info literal in the claude-code 2.1.280 binary.
    // Opus 5.5 requires >= 2.1.280; older values get a 400.
    expect(VERSION).toBe("2.1.280")
    expect(BUILD_TIME).toBe("2026-09-21T20:40:17Z")
    expect(GIT_SHA).toBe("80abbfe7d7232280011ff01a21ae3338f4c6e372")
  })

  it("pins the Stainless SDK version bundled in that CLI", () => {
    expect(STAINLESS_SDK_VERSION).toBe("0.112.1")
  })

  it("derives every User-Agent from VERSION", () => {
    expect(USER_AGENT).toBe(`claude-cli/${VERSION} (external, cli)`)
    expect(USER_AGENT_OAUTH).toBe(`claude-code/${VERSION}`)
    expect(USER_AGENT_MCP).toBe(`claude-code/${VERSION} (cli)`)
  })
})

describe("buildHashFor", () => {
  /**
   * Independent re-implementation of the CLI algorithm, written from the
   * decompiled source rather than by calling the module under test, so this
   * is a real cross-check and not a tautology.
   */
  const reference = (text: string, version: string): string =>
    createHash("sha256")
      .update(`59cf53e54c78${[4, 7, 20].map((i) => text[i] || "0").join("")}${version}`)
      .digest("hex")
      .slice(0, 3)

  it("matches the reference implementation on the empty prompt", () => {
    expect(buildHashFor("")).toBe(reference("", "2.1.280"))
    expect(buildHashFor("")).toBe("d7b")
  })

  it("matches the reference implementation on a real prompt", () => {
    const prompt = "Analyze this codebase and tell me what it does"
    expect(buildHashFor(prompt)).toBe(reference(prompt, "2.1.280"))
    expect(buildHashFor(prompt)).toBe("e98")
  })

  it("varies with the first user message", () => {
    expect(buildHashFor("hello world, this is a longer prompt")).not.toBe(buildHashFor(""))
  })

  it("only reads characters 4, 7 and 20 (all others are ignored)", () => {
    // Same chars at 4/7/20, everything else different → same suffix.
    const a = "0000a00b000000000000c"
    const b = "zzzzazzbzzzzzzzzzzzzc"
    expect(a[4]).toBe(b[4])
    expect(a[7]).toBe(b[7])
    expect(a[20]).toBe(b[20])
    expect(buildHashFor(a)).toBe(buildHashFor(b))
  })

  it("pads short prompts with '0' instead of throwing", () => {
    expect(buildHashFor("hi")).toBe(reference("hi", "2.1.280"))
    expect(buildHashFor("hi")).toMatch(/^[0-9a-f]{3}$/)
  })

  it("changes when the version changes", () => {
    expect(buildHashFor("", "2.1.154")).not.toBe(buildHashFor("", "2.1.280"))
  })

  it("backs the default BUILD_HASH", () => {
    expect(BUILD_HASH).toBe(buildHashFor(""))
    expect(BUILD_HASH).toMatch(/^[0-9a-f]{3}$/)
  })
})
