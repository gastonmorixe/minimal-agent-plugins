/**
 * Test fixture: run the real `host-mode.ts` handler in process, with
 * in-memory stdio, a fake {@link HostRuntime}, and an abort controller the
 * test owns (it stands in for core's SIGTERM / SIGINT signal).
 *
 * @module __fixtures__/in-memory-host
 */

import type { HostModeContext } from "@minimal-agent/core/host-kit/host-mode"

import handler from "../host-mode.ts"

import type { FakeRuntime } from "./fake-runtime.ts"

/** One parsed stdout line. */
export interface Msg {
  readonly jsonrpc?: string
  readonly id?: number | string | null
  readonly method?: string
  readonly params?: { readonly update?: Record<string, unknown> }
  readonly result?: Record<string, unknown>
  readonly error?: { readonly code: number; readonly message: string }
}

/**
 * Start the handler. `end()` closes stdin (EOF). `abort` is the context
 * signal. `cwd` is the process cwd (default `/work`).
 */
export function startInMemoryHost(rt: FakeRuntime, cwd = "/work") {
  const queue: string[] = []
  let wake: (() => void) | undefined
  let ended = false
  const stdin = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as string
        if (ended) return
        await new Promise<void>((r) => {
          wake = r
        })
      }
    },
  }
  const out: string[] = []
  const noop = (): void => {}
  const abort = new AbortController()
  const ctx = {
    argv: [],
    stdin,
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: noop },
    abort: abort.signal,
    cwd,
    env: {},
    log: { debug: noop, info: noop, warn: noop, error: noop },
    runtime: rt,
  } as unknown as HostModeContext
  const exit = handler(ctx)
  let exited = false
  void exit.then(() => {
    exited = true
  })
  const lines = (): Msg[] =>
    out
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Msg)
  const sendRaw = (line: string): void => {
    queue.push(line)
    wake?.()
  }
  const send = (msg: unknown): void => sendRaw(`${JSON.stringify(msg)}\n`)
  const reply = async (id: number): Promise<Msg> => {
    for (let i = 0; i < 400; i++) {
      const hit = lines().find((m) => m.id === id && m.method === undefined)
      if (hit) return hit
      await Bun.sleep(5)
    }
    throw new Error(`no reply ${id}; stdout:\n${out.join("")}`)
  }
  const end = (): void => {
    ended = true
    wake?.()
  }
  return { send, sendRaw, reply, lines, end, exit, abort, isExited: () => exited }
}

/** Start the handler and run `initialize` plus `session/new`. */
export async function openInMemorySession(rt: FakeRuntime) {
  const h = startInMemoryHost(rt)
  h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })
  await h.reply(1)
  h.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/work", mcpServers: [] } })
  const created = await h.reply(2)
  return { ...h, sessionId: created.result?.sessionId as string }
}
