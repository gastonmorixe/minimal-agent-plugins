/**
 * Spawn-test fixture: run the real `host-mode.ts` handler in its own OS
 * process, with real stdio and a fake runtime. It builds the context the
 * same way core's `run-host-mode.ts` does for the abort signal:
 * `process.once` listeners for SIGTERM and SIGINT abort `ctx.abort`. A
 * `process.once` listener replaces the default signal action, so the
 * process exits only when the handler reads `ctx.abort`.
 *
 * Every turn waits for its abort signal, so a prompt stays open until a
 * cancel, EOF, or a signal ends it.
 *
 * @module __fixtures__/host-mode-process
 */

import type { HostModeContext } from "@minimal-agent/core/host-kit/host-mode"

import handler from "../host-mode.ts"

import { createFakeRuntime } from "./fake-runtime.ts"

// biome-ignore lint/suspicious/noConsole: rerouting console.log itself.
console.log = (...a: unknown[]) => console.error(...a)

const abortController = new AbortController()
const onSignal = (): void => abortController.abort()
process.once("SIGINT", onSignal)
process.once("SIGTERM", onSignal)

const rt = createFakeRuntime()
for (let i = 0; i < 8; i++) rt.turns.push({ events: [], outcome: "aborted", waitForAbort: true })

const write = (source: string, message: string): void => {
  process.stderr.write(`[${source}] ${message}\n`)
}
const ctx = {
  argv: [],
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  abort: abortController.signal,
  cwd: process.cwd(),
  env: {},
  log: { debug: write, info: write, warn: write, error: write },
  runtime: rt,
} as unknown as HostModeContext

const code = await handler(ctx)
process.stderr.write(`[host-mode-process] handler returned ${code}, closeCalls=${rt.closeCalls}\n`)
process.exitCode = code
