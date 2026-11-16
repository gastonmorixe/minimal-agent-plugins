/**
 * Child-process fixture for `runner-signal.test.ts`. It loads the real
 * runner, starts one hook that leaves a long-lived grandchild, prints
 * `ready` once the grandchild pid file exists, and waits for a signal.
 *
 * argv: `<mode> <hook script> <grandchild pid file>`.
 *
 * Mode:
 *   - `alone`  : only the hooks listener.
 *   - `fanout` : plus a tagged fan-out listener that copies the
 *                ma-background behavior (count untagged owners, re-raise
 *                when there is none). Installed BEFORE the hooks listener.
 *   - `host`   : plus an untagged host listener that owns the signal. The
 *                fixture prints `host` and exits 0 itself after the hook run
 *                ends.
 *
 * @module engine/runner-signal.fixture
 */

import { existsSync, readFileSync, writeSync } from "node:fs"

import { runHandler } from "./runner.ts"

const [mode = "alone", script = "", pidFile = ""] = process.argv.slice(2)

const say = (line: string): void => {
  writeSync(1, `${line}\n`)
}

const FANOUT = Symbol.for("minimal-agent.signal-fanout")
type Tagged = ((...args: unknown[]) => void) & { [FANOUT]?: true }

let hostSaw = false

if (mode === "fanout") {
  for (const sig of ["SIGTERM", "SIGHUP"] as const) {
    const l: Tagged = (): void => {
      const owners = process.listeners(sig).filter((x) => (x as Tagged)[FANOUT] !== true).length
      say(`fanout ${sig}`)
      if (owners > 0) return
      process.off(sig, l)
      process.kill(process.pid, sig)
    }
    l[FANOUT] = true
    process.on(sig, l)
  }
}

if (mode === "host") {
  for (const sig of ["SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      hostSaw = true
      say("host")
    })
  }
}

const run = runHandler({
  handler: { type: "command", command: script },
  stdin: "{}",
  env: {},
  cwd: process.cwd(),
  timeoutMs: 60_000,
})

while (!(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "")) {
  await Bun.sleep(20)
}
say("ready")

// Keep the host alive on purpose, like a real harness event loop.
setInterval(() => {}, 1000)

await run
say("run-done")
if (hostSaw) process.exit(0)
