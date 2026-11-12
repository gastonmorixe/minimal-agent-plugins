/**
 * `callBackend` run modes: the backend argv comes from core `selfSpawn`
 * (`[bun, <script>]` from source, `[<binary>, "__run", "ma-fetch/<name>"]`
 * compiled) and the backend env never carries `BUN_BE_BUN`.
 */

import { describe, expect, test } from "bun:test"

import manifest from "../manifest.json"

import {
  buildBackendArgv,
  buildBackendEnv,
  callBackend,
  EMBEDDED_BACKENDS,
  type SpawnedProcess,
  type SpawnFn,
} from "./backend.ts"
import { defaultConfig, type FetchConfig } from "./config.ts"

function binCfg(overrides: Partial<FetchConfig> = {}): FetchConfig {
  return { ...defaultConfig(), backends: { obscura: { bin: "/managed/obscura" } }, ...overrides }
}

function fakeProc(opts: { stdout?: string; exitCode?: number }): SpawnedProcess {
  const enc = new TextEncoder()
  const out = opts.stdout ?? ""
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        if (out.length > 0) c.enqueue(enc.encode(out))
        c.close()
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        c.close()
      },
    }),
    exited: Promise.resolve(opts.exitCode ?? 0),
    kill: () => true,
  }
}

describe("buildBackendArgv (selfSpawn)", () => {
  test("source run: [execPath, <pkg>/backends/<name>.ts]", () => {
    expect(
      buildBackendArgv("obscura", "/p/backends/obscura.ts", {
        execPath: "/usr/bin/bun",
        standalone: false,
      }),
    ).toEqual(["/usr/bin/bun", "/p/backends/obscura.ts"])
  })
  test("compiled: [<binary>, __run, ma-fetch/<name>]", () => {
    expect(
      buildBackendArgv("obscura", "/p/backends/obscura.ts", {
        execPath: "/opt/minimal-agent",
        standalone: true,
      }),
    ).toEqual(["/opt/minimal-agent", "__run", "ma-fetch/obscura"])
  })
  test("EMBEDDED_BACKENDS matches the manifest scripts map", () => {
    const scripts = (manifest as { scripts: Record<string, string> }).scripts
    expect([...EMBEDDED_BACKENDS].sort()).toEqual(Object.keys(scripts).sort())
    for (const name of EMBEDDED_BACKENDS) {
      expect(scripts[name]).toBe(`./backends/${name}.ts`)
    }
    expect((manifest as { id: string }).id).toBe("ma-fetch")
  })
})

describe("callBackend - run modes", () => {
  const input = { url: "https://x", format: "markdown", waitUntil: "load", timeoutSec: 30 } as const

  test("compiled: spawns __run ma-fetch/obscura without a script file on disk", async () => {
    const calls: string[][] = []
    const spawnFn: SpawnFn = (argv) => {
      calls.push([...argv])
      return fakeProc({ stdout: "ok", exitCode: 0 })
    }
    const result = await callBackend(
      "/$bunfs/root",
      binCfg(),
      input,
      new AbortController().signal,
      {
        spawnFn,
        existsFn: () => false, // no file: the embedded map is what counts
        parentExitHook: () => () => {},
        selfSpawn: { execPath: "/opt/minimal-agent", standalone: true },
      },
    )
    expect(result.ok).toBe(true)
    expect(calls).toEqual([["/opt/minimal-agent", "__run", "ma-fetch/obscura"]])
  })

  test("compiled: a backend not declared in scripts is scriptMissing, no spawn", async () => {
    let spawned = false
    const spawnFn: SpawnFn = () => {
      spawned = true
      return fakeProc({})
    }
    const result = await callBackend(
      "/$bunfs/root",
      binCfg({ backend: "lightpanda" }),
      input,
      new AbortController().signal,
      { spawnFn, existsFn: () => true, selfSpawn: { execPath: "/opt/ma", standalone: true } },
    )
    expect(result.scriptMissing).toBe(true)
    expect(spawned).toBe(false)
  })

  test("the backend env never carries BUN_BE_BUN", () => {
    const env = buildBackendEnv(binCfg(), input, { PATH: "/usr/bin", BUN_BE_BUN: "1" })
    expect("BUN_BE_BUN" in env).toBe(false)
    expect(env.PATH).toBe("/usr/bin")
    expect(env.MA_FETCH_URL).toBe("https://x")
  })
})
