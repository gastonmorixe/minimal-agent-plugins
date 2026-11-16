/**
 * Shared contract suite every dialect adapter must pass (SPEC.md "Adapter
 * contract tests"): parse never throws, unsupported items are flagged,
 * encode gives a JSON stdin, decode maps fixture outcomes without throwing.
 *
 * Call it from an adapter's test file:
 * `runAdapterContract(() => ({ adapter, fixtures }))`.
 *
 * @module engine/adapter-contract
 */

import { describe, expect, test } from "bun:test"

import type {
  CanonicalHook,
  DiscoverEnv,
  HookDialectAdapter,
  InvocationContext,
  RunOutcome,
  SourceRef,
} from "./types.ts"

/** Dialect-specific inputs for the contract suite. */
export interface AdapterContractFixtures {
  /** Config text with at least one supported command hook. */
  validConfig: string
  /** Config text with an unsupported event. */
  unsupportedEventConfig: string
  /** Config text with an unsupported handler type. */
  unsupportedTypeConfig: string
  /** A channel and payload the valid hook matches. */
  sample: { channel: string; payload: unknown }
  /** A blocking channel where exit 2 must deny. */
  blockingChannel: string
}

/** What a contract factory returns. */
export interface AdapterContractSubject {
  adapter: HookDialectAdapter
  fixtures: AdapterContractFixtures
}

const outcome = (o: Partial<RunOutcome>): RunOutcome => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  durationMs: 1,
  ...o,
})

/** Register the contract suite for one adapter. */
export function runAdapterContract(factory: () => AdapterContractSubject): void {
  const { adapter, fixtures } = factory()
  const source: SourceRef = {
    id: "contract",
    path: "/contract/hooks.json",
    scope: "user",
    precedence: 0,
  }
  const env: DiscoverEnv = {
    home: "/h",
    agentHome: "/h/.minimal-agent",
    projectRoot: "/p",
    plugins: [{ name: "x", root: "/plug/x" }],
  }
  const inv: InvocationContext = { sid: "s1", cwd: "/p", projectDir: "/p", agentMode: "default" }
  const firstOk = (): CanonicalHook => {
    const h = adapter.parse(source, fixtures.validConfig).hooks.find((x) => x.support === "ok")
    if (!h) throw new Error("valid fixture has no supported hook")
    return h
  }

  describe(`adapter contract: ${adapter.id}`, () => {
    test("discover returns absolute paths and never throws", () => {
      const list = adapter.discover(env)
      for (const s of list) expect(s.path.startsWith("/")).toBe(true)
    })

    test("parse never throws on junk", () => {
      for (const junk of ["", "{", "[]", "null", "42", '{"hooks": 1}', '{"hooks": {"x": [1]}}']) {
        expect(() => adapter.parse(source, junk)).not.toThrow()
      }
    })

    test("valid config yields supported hooks with dialect, trust key and hash", () => {
      const r = adapter.parse(source, fixtures.validConfig)
      const ok = r.hooks.filter((h) => h.support === "ok")
      expect(ok.length).toBeGreaterThan(0)
      for (const h of ok) {
        expect(h.dialect).toBe(adapter.id)
        expect(h.trustKey.startsWith(`${adapter.id}:`)).toBe(true)
        expect(h.contentHash.length).toBeGreaterThan(8)
        expect(h.channel.length).toBeGreaterThan(0)
      }
      const keys = r.hooks.map((h) => h.trustKey)
      expect(new Set(keys).size).toBe(keys.length)
    })

    test("unsupported event and type are flagged, not dropped", () => {
      const ev = adapter.parse(source, fixtures.unsupportedEventConfig).hooks
      expect(ev.some((h) => h.support === "unsupported-event")).toBe(true)
      const ty = adapter.parse(source, fixtures.unsupportedTypeConfig).hooks
      expect(ty.some((h) => h.support === "unsupported-type")).toBe(true)
    })

    test("hash is stable across parses", () => {
      const a = adapter.parse(source, fixtures.validConfig).hooks.map((h) => h.contentHash)
      const b = adapter.parse(source, fixtures.validConfig).hooks.map((h) => h.contentHash)
      expect(a).toEqual(b)
    })

    test("matcher closure matches the sample", () => {
      const h = firstOk()
      expect(h.matches(fixtures.sample)).toBe(true)
    })

    test("encodeInput gives JSON stdin and string env", () => {
      const h = firstOk()
      const { stdin, env: e } = adapter.encodeInput(
        h,
        fixtures.sample.channel,
        fixtures.sample.payload,
        inv,
      )
      expect(() => JSON.parse(stdin)).not.toThrow()
      for (const v of Object.values(e)) expect(typeof v).toBe("string")
    })

    test("decodeOutput maps fixture outcomes and never throws", () => {
      const h = firstOk()
      const ch = fixtures.blockingChannel
      const p = fixtures.sample.payload
      expect(adapter.decodeOutput(h, ch, outcome({}), p).decision).not.toBe("deny")
      const denied = adapter.decodeOutput(h, ch, outcome({ exitCode: 2, stderr: "no" }), p)
      expect(denied.decision).toBe("deny")
      expect(denied.reason).toContain("no")
      const other = adapter.decodeOutput(h, ch, outcome({ exitCode: 1, stderr: "x" }), p)
      expect(other.decision).not.toBe("deny")
      const timeout = adapter.decodeOutput(
        h,
        ch,
        outcome({ exitCode: null, timedOut: true, error: "timed out" }),
        p,
      )
      expect(timeout.decision).not.toBe("deny")
      for (const s of ["{", "not json", '{"decision": 5}', "[1,2]"]) {
        const r = adapter.decodeOutput(h, ch, outcome({ stdout: s }), p)
        expect(Array.isArray(r.context)).toBe(true)
      }
    })
  })
}
