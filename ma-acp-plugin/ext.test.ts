/**
 * Tests for `ext.ts`: the shared negotiation vectors of
 * `docs/acp-extensions.md` section 7.4 (Studio patch E2 runs the same
 * table), plus the key name and the `_meta` reader.
 *
 * @module ext.test
 */

import { describe, expect, it } from "bun:test"

import {
  EXT_CAPABILITY_KEY,
  EXT_LOCAL_FEATURES,
  EXT_NAMESPACE,
  EXT_VERSION,
  effectiveFeatures,
  hasExtFeature,
  localExt,
  NO_EXT,
  readPeerExt,
} from "./ext.ts"

const local = { version: 1, features: ["usage"] }

describe("ext constants", () => {
  it("uses the minimal-agent namespace and the v1 local advert", () => {
    expect(EXT_NAMESPACE).toBe("minimal-agent")
    expect(EXT_CAPABILITY_KEY).toBe("minimal-agent/ext")
    expect(EXT_VERSION).toBe(1)
    expect(EXT_LOCAL_FEATURES).toEqual(["usage", "structuredOutput", "sampling"])
    expect(localExt()).toEqual({
      version: 1,
      features: ["usage", "structuredOutput", "sampling"],
    })
  })

  it("localExt(supported) lists only the supported features, in order", () => {
    expect(localExt((f) => f === "usage")).toEqual({ version: 1, features: ["usage"] })
    expect(localExt((f) => f !== "structuredOutput")).toEqual({
      version: 1,
      features: ["usage", "sampling"],
    })
    expect(EXT_LOCAL_FEATURES).toEqual(["usage", "structuredOutput", "sampling"])
  })
})

describe("effectiveFeatures: shared vectors (contract 7.4)", () => {
  const vectors: [string, unknown, { version: number; features: string[] }][] = [
    ["absent", undefined, { version: 0, features: [] }],
    ['"yes" (not an object)', "yes", { version: 0, features: [] }],
    ["v0 [usage]", { version: 0, features: ["usage"] }, { version: 0, features: [] }],
    [
      "v1 [usage, structuredOutput]",
      { version: 1, features: ["usage", "structuredOutput"] },
      { version: 1, features: ["usage"] },
    ],
    [
      "v2 [usage, newThing]",
      { version: 2, features: ["usage", "newThing"] },
      { version: 1, features: ["usage"] },
    ],
    [
      'v1 [1, "usage"] (bad item)',
      { version: 1, features: [1, "usage"] },
      { version: 0, features: [] },
    ],
  ]
  for (const [name, peer, want] of vectors) {
    it(`local v1 [usage], peer ${name}`, () => {
      expect(effectiveFeatures(local, peer)).toEqual(want)
    })
  }
})

describe("effectiveFeatures: other malformed input", () => {
  it("never throws and gives the empty set", () => {
    const bad: unknown[] = [
      null,
      42,
      [],
      { version: 1 },
      { features: ["usage"] },
      { version: 1.5, features: ["usage"] },
      { version: "1", features: ["usage"] },
      { version: 1, features: "usage" },
    ]
    for (const peer of bad) expect(effectiveFeatures(local, peer)).toEqual(NO_EXT)
    expect(effectiveFeatures(undefined, local)).toEqual(NO_EXT)
    const evil = {
      get version(): number {
        throw new Error("boom")
      },
    }
    expect(effectiveFeatures(local, evil)).toEqual(NO_EXT)
  })

  it("drops names not defined for the effective version", () => {
    const l = { version: 1, features: ["usage", "notDefined"] }
    expect(effectiveFeatures(l, l)).toEqual({ version: 1, features: ["usage"] })
  })

  it("hasExtFeature reads the effective set", () => {
    expect(hasExtFeature(effectiveFeatures(local, local), "usage")).toBe(true)
    expect(hasExtFeature(NO_EXT, "usage")).toBe(false)
  })
})

describe("readPeerExt", () => {
  it("reads capabilities._meta[minimal-agent/ext] and ignores other shapes", () => {
    expect(readPeerExt({ _meta: { "minimal-agent/ext": local } })).toEqual(local)
    expect(readPeerExt({ _meta: { "com.example/x": 1 } })).toBeUndefined()
    expect(readPeerExt({})).toBeUndefined()
    expect(readPeerExt({ _meta: "x" })).toBeUndefined()
    expect(readPeerExt(undefined)).toBeUndefined()
    expect(readPeerExt(null)).toBeUndefined()
  })
})
