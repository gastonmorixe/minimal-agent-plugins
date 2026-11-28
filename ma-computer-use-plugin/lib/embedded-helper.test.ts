/**
 * Tests of the helper extract from a compiled CLI.
 *
 * The unit tests inject every effect. The handler tests register a REAL
 * embedded table in core (the same pattern as
 * `ma-config-plugin/handlers/wiring.test.ts`), with an extract cache in a temp
 * folder from `os.tmpdir()`. No daemon runs: `ensure` and `spawnDaemon` are
 * fakes, and the fake `ensure` never calls the probe, so no socket is opened.
 *
 * @module lib/embedded-helper.test
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import {
  clearEmbeddedPlugins,
  type EmbeddedPluginTable,
  pluginPackageFor,
  pruneEmbeddedCache,
  registerEmbeddedPlugins,
} from "@minimal-agent/core/host-kit/embedded-plugins"

import { type HandlerDeps, runWithDeps } from "../handlers/computer.ts"

import { type ExtractResult, extractHelper, HELPER_KEY } from "./embedded-helper.ts"
import { missingHelperText } from "./missing-helper.ts"
import type { TUIContext } from "./types.ts"

/** An `execPath` fake that records its calls. */
function recorder(result: (dir: string, rel: string) => string) {
  const calls: Array<[string, string]> = []
  const execPath = (dir: string, rel: string): string => {
    calls.push([dir, rel])
    return result(dir, rel)
  }
  return { calls, execPath }
}

describe("extractHelper", () => {
  test("HELPER_KEY is path 2 of helperBinary", () => {
    expect(HELPER_KEY).toBe("native/build/ComputerUseHelper")
  })

  test("CUD_HELPER is set: execPath is not called", () => {
    const { calls, execPath } = recorder(() => "/never")
    const r = extractHelper("/pkg", { env: { CUD_HELPER: "/custom/helper" }, execPath })
    expect(r).toEqual({ ok: true, path: "/custom/helper" })
    expect(calls).toEqual([])
  })

  test("execPath gets the package dir and HELPER_KEY", () => {
    const { calls, execPath } = recorder((dir, rel) => `${dir}/${rel}`)
    const r = extractHelper("/pkg", { env: {}, execPath, cache: new Map() })
    expect(r).toEqual({ ok: true, path: "/pkg/native/build/ComputerUseHelper" })
    expect(calls).toEqual([["/pkg", HELPER_KEY]])
  })

  test("a second call for the same dir uses the cache when the file exists", () => {
    const { calls, execPath } = recorder((dir, rel) => `${dir}/${rel}`)
    const cache = new Map<string, string>()
    const deps = { env: {}, execPath, cache, exists: () => true }
    extractHelper("/pkg", deps)
    const r = extractHelper("/pkg", deps)
    expect(r).toEqual({ ok: true, path: "/pkg/native/build/ComputerUseHelper" })
    expect(calls.length).toBe(1)
    extractHelper("/other", deps)
    expect(calls.length).toBe(2)
  })

  test("a cached path whose file is gone is extracted again", () => {
    const { calls, execPath } = recorder((dir, rel) => `${dir}/${rel}`)
    const deps = { env: {}, execPath, cache: new Map<string, string>(), exists: () => false }
    extractHelper("/pkg", deps)
    extractHelper("/pkg", deps)
    expect(calls.length).toBe(2)
  })

  test("the default cache is one map for the process", () => {
    const { calls, execPath } = recorder((dir, rel) => `${dir}/${rel}`)
    const dir = `/process-cache-${process.pid}-${Date.now()}`
    extractHelper(dir, { env: {}, execPath, exists: () => true })
    extractHelper(dir, { env: {}, execPath, exists: () => true })
    expect(calls.length).toBe(1)
  })

  test("execPath throws: ok false with the message, no throw, no cache entry", () => {
    const cache = new Map<string, string>()
    const execPath = () => {
      throw new Error("EACCES: permission denied, mkdir '/ro/native/build'")
    }
    const r = extractHelper("/ro", { env: {}, execPath, cache })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("/ro/native/build/ComputerUseHelper")
    expect(r.error).toContain("EACCES: permission denied")
    expect(cache.size).toBe(0)
  })

  test("a thrown value that is not an Error is given as text", () => {
    const execPath = () => {
      throw "disk full"
    }
    const r = extractHelper("/pkg", { env: {}, execPath, cache: new Map() })
    expect(r).toEqual({
      ok: false,
      error: "could not extract the helper to /pkg/native/build/ComputerUseHelper: disk full",
    })
  })
})

/** A tool context for the handler. */
function ctx(packageDir: string): TUIContext {
  return {
    trigger: { type: "tool", name: "Computer", input: { action: "apps" } },
    packageDir,
    cwd: "/work",
  } as unknown as TUIContext
}

/** Fakes for the daemon steps, with a record of the call order. */
function fakes(extract?: (dir: string) => ExtractResult) {
  const order: string[] = []
  const deps: HandlerDeps = {
    ensure: async () => {
      order.push("ensure")
      return { ok: false, header: "stop", error: "stopped after the helper lookup" }
    },
    spawnDaemon: () => {
      order.push("spawn")
    },
  }
  if (extract) {
    deps.extract = (dir) => {
      order.push("extract")
      return extract(dir)
    }
  }
  return { order, deps }
}

describe("runWithDeps: helper extract", () => {
  test("an extract failure gives a tool error with no log hint and no spawn", async () => {
    const { order, deps } = fakes(() => ({ ok: false, error: "could not extract: disk full" }))
    const r = await runWithDeps(ctx("/pkg"), deps)
    expect(r.kind).toBe("tool_result")
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
    // L5: the extract runs in the CLI process and writes nothing to the helper log.
    expect(r.content).toBe("Computer: could not extract: disk full")
    expect(r.content).not.toContain("log")
    expect(r.displayHeader).toContain("helper extract failed")
    expect(r.content).not.toContain("cud")
    expect(r.content).not.toContain("bun ")
    expect(order).toEqual(["extract"])
  })

  test("extract runs before ensure", async () => {
    const { order, deps } = fakes(() => ({ ok: true, path: "/x" }))
    deps.socketFetch = async () => ({ status: 200, body: { ok: true } })
    await runWithDeps(ctx("/pkg"), deps)
    expect(order).toEqual(["extract", "ensure"])
  })
})

const BUILD_ID = "test-build-1"
const PACKAGE = "ma-computer-use-plugin"
const HELPER_BYTES = "#!/bin/sh\nexit 0\n"

/**
 * Register a real embedded table for the duration of `fn`. The package has
 * the helper key when `withHelper` is true. `CUD_HELPER` is unset meanwhile,
 * so the default extract and `helperBinary` take the embedded path.
 */
async function withEmbedded(
  withHelper: boolean,
  fn: (packageDir: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cu-embedded-helper-"))
  const savedHelper = process.env.CUD_HELPER
  delete process.env.CUD_HELPER
  try {
    const src = join(root, "helper-source")
    writeFileSync(src, HELPER_BYTES, { mode: 0o644 })
    const files: Record<string, string> = withHelper ? { [HELPER_KEY]: src } : {}
    const table: EmbeddedPluginTable = {
      buildId: BUILD_ID,
      packages: {
        [PACKAGE]: { texts: { "manifest.json": '{"id":"computer-use"}' }, modules: {}, files },
      },
    }
    const cacheRoot = join(root, "cache")
    registerEmbeddedPlugins(table, { cacheRoot })
    const packageDir = join(cacheRoot, BUILD_ID, PACKAGE)
    expect(pluginPackageFor(packageDir).kind).toBe("embedded")
    await fn(packageDir)
  } finally {
    pruneEmbeddedCache()
    clearEmbeddedPlugins()
    if (savedHelper === undefined) delete process.env.CUD_HELPER
    else process.env.CUD_HELPER = savedHelper
    rmSync(root, { recursive: true, force: true })
  }
}

describe("runWithDeps: real embedded table", () => {
  test("the helper key is extracted with mode 0755 and the handler passes the lookup", async () => {
    await withEmbedded(true, async (packageDir) => {
      const { order, deps } = fakes()
      const r = await runWithDeps(ctx(packageDir), deps)
      const bin = join(packageDir, HELPER_KEY)
      const st = statSync(bin)
      expect(st.isFile()).toBe(true)
      expect(st.mode & 0o777).toBe(0o755)
      expect(readFileSync(bin, "utf8")).toBe(HELPER_BYTES)
      // The handler got to ensure, so the missing-helper check passed.
      expect(order).toEqual(["ensure"])
      expect(r.kind).toBe("tool_result")
      if (r.kind !== "tool_result") return
      expect(r.content).toBe("Computer: stopped after the helper lookup")
    })
  })

  test("no helper key: nothing is written and the compiled-CLI text is given", async () => {
    await withEmbedded(false, async (packageDir) => {
      const { order, deps } = fakes()
      const r = await runWithDeps(ctx(packageDir), deps)
      const bin = join(packageDir, HELPER_KEY)
      expect(() => statSync(bin)).toThrow()
      expect(order).toEqual([])
      expect(r.kind).toBe("tool_result")
      if (r.kind !== "tool_result") return
      expect(r.is_error).toBe(true)
      expect(r.content).toBe(missingHelperText(bin, false))
      expect(r.displayHeader).toContain("helper not included")
    })
  })
})
