/**
 * The shared parent-exit fan-out must not keep the host alive on a signal.
 *
 * A `process.on("SIGTERM")` listener removes the default action (exit). When
 * the fan-out is the only listener, nothing else exits, so the host process
 * would stay alive. These tests run a real child bun process that subscribes
 * one fake job and then receives SIGTERM.
 */

import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

const BACKEND = join(import.meta.dir, "backend.ts")

/**
 * Child script: subscribe one fake job, keep the loop alive, print "ready".
 * With `unsubInCallback`, the job callback unsubscribes itself as it runs.
 */
function childScript(extraListener: boolean, unsubInCallback = false): string {
  return [
    `import { defaultParentExitHook } from ${JSON.stringify(BACKEND)}`,
    extraListener ? `process.on("SIGTERM", () => process.exit(143))` : "",
    unsubInCallback
      ? `const unsub = defaultParentExitHook(() => unsub())`
      : `defaultParentExitHook(() => {})`,
    `setInterval(() => {}, 1000)`,
    `console.log("ready")`,
  ].join("\n")
}

const started: number[] = []

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
})

async function runAndTerm(
  extraListener: boolean,
  unsubInCallback = false,
): Promise<{
  code: number | null
  signal: string | null
  exitedInTime: boolean
}> {
  const proc = Bun.spawn([process.execPath, "-e", childScript(extraListener, unsubInCallback)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  })
  started.push(proc.pid)
  const reader = proc.stdout.getReader()
  let out = ""
  while (!out.includes("ready")) {
    const { value, done } = await reader.read()
    if (done) break
    out += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  expect(out).toContain("ready")
  process.kill(proc.pid, "SIGTERM")
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1000))
  const res = await Promise.race([proc.exited, timeout])
  return {
    code: proc.exitCode,
    signal: proc.signalCode === null ? null : String(proc.signalCode),
    exitedInTime: res !== "timeout",
  }
}

const REGISTRY = join(import.meta.dir, "..", "..", "ma-background-plugin", "lib", "registry.ts")

/**
 * Child script with BOTH fan-outs (ma-speak and ma-background) and no other
 * listener. Each fan-out callback prints its mark.
 */
function bothScript(): string {
  return [
    `import { writeSync } from "node:fs"`,
    `import { defaultParentExitHook } from ${JSON.stringify(BACKEND)}`,
    `import { defaultOnParentExit } from ${JSON.stringify(REGISTRY)}`,
    `defaultParentExitHook(() => writeSync(1, "speak-fanout\\n"))`,
    `defaultOnParentExit(() => writeSync(1, "bg-fanout\\n"))`,
    `setInterval(() => {}, 1000)`,
    `writeSync(1, "ready\\n")`,
  ].join("\n")
}

describe("defaultParentExitHook - with the ma-background fan-out in the same host", () => {
  for (const [sig, code] of [
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    test(`${sig}: the host exits by ${sig} within 1 s, each fan-out once`, async () => {
      const proc = Bun.spawn([process.execPath, "-e", bothScript()], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
      })
      started.push(proc.pid)
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      let out = ""
      while (!out.includes("ready\n")) {
        const { value, done } = await reader.read()
        if (done) break
        out += decoder.decode(value)
      }
      process.kill(proc.pid, sig)
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1000))
      const res = await Promise.race([proc.exited, timeout])
      expect(res).not.toBe("timeout")
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        out += decoder.decode(value)
      }
      const lines = out.split("\n")
      expect(proc.signalCode === null ? null : String(proc.signalCode)).toBe(sig)
      // Shell form of the same end: 128 + signal number.
      expect(res).toBe(code)
      expect(lines.filter((l) => l === "speak-fanout").length).toBe(1)
      expect(lines.filter((l) => l === "bg-fanout").length).toBe(1)
    })
  }
})

describe("defaultParentExitHook - signal default action", () => {
  test("sole SIGTERM listener: the host still exits by SIGTERM within 1 s", async () => {
    const r = await runAndTerm(false)
    expect(r.exitedInTime).toBe(true)
    expect(r.signal).toBe("SIGTERM")
  })

  test("a job callback that unsubscribes as it runs: the host still exits", async () => {
    const r = await runAndTerm(false, true)
    expect(r.exitedInTime).toBe(true)
    expect(r.signal).toBe("SIGTERM")
  })

  test("another listener that exits 143: the host exits 143", async () => {
    const r = await runAndTerm(true)
    expect(r.exitedInTime).toBe(true)
    expect(r.code).toBe(143)
  })
})
