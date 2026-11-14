/**
 * Child-process fixture for `registry-signal.test.ts`. It loads the real
 * registry, tracks one fake runner, prints `ready`, and waits for a signal.
 * Each fan-out (a `closeStdin` call on the fake handle) prints `fanout`.
 *
 * Mode (argv[2]):
 *   - `alone`        : no other SIGTERM listener.
 *   - `other-first`  : a SIGTERM listener that calls `process.exit(143)`,
 *                      installed BEFORE the registry (the CLI order).
 *   - `other-after`  : the same listener, installed AFTER the registry.
 *   - `both`         : the registry AND the ma-speak fan-out
 *                      (`defaultParentExitHook`) in one host, no other
 *                      listener. ma-speak prints `speak-fanout`.
 *   - `both-other`   : `both`, plus the `process.exit(143)` SIGTERM listener
 *                      installed after the two fan-outs.
 *
 * Every `process.kill` at this process prints `reraise <signal>`, so a test
 * can count the re-raises.
 *
 * @module lib/registry-signal.fixture
 */

import { writeSync } from "node:fs"

import { defaultParentExitHook } from "../../ma-speak-plugin/lib/backend.ts"

import { defaultOnParentExit, RunnerRegistry } from "./registry.ts"

const mode = process.argv[2] ?? "alone"
const withSpeak = mode === "both" || mode === "both-other"

// Write with a sync fd write so the line reaches the parent before any exit.
const say = (line: string): void => {
  writeSync(1, `${line}\n`)
}

// Record each re-raise at this process, then send the signal as usual.
const realKill = process.kill.bind(process)
process.kill = ((pid: number, signal?: NodeJS.Signals | number): true => {
  if (pid === process.pid) say(`reraise ${String(signal)}`)
  return realKill(pid, signal)
}) as typeof process.kill

const exitOnTerm = (): void => {
  process.exit(143)
}

if (mode === "other-first") process.on("SIGTERM", exitOnTerm)

const registry = new RunnerRegistry({
  onParentExit: defaultOnParentExit,
  killRunner: () => {},
})
registry.track("j1", { pid: 0, closeStdin: () => say("fanout") })

if (withSpeak) defaultParentExitHook(() => say("speak-fanout"))

if (mode === "other-after" || mode === "both-other") process.on("SIGTERM", exitOnTerm)

say("ready")

// Keep the host alive on purpose, like a real harness event loop. Only the
// signal default action or the other listener can end this process.
setInterval(() => {}, 1000)
