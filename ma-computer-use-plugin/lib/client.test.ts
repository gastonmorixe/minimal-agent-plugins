/**
 * Tests of the socket transport time limit (review R1). The fetch is a fake,
 * so no daemon runs.
 *
 * @module lib/client.test
 */

import { describe, expect, test } from "bun:test"

import { runWithDeps } from "../handlers/computer.ts"

import {
  type FetchImpl,
  HelperTimeoutError,
  makeBunSocketFetch,
  PING_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  type SocketFetch,
} from "./client.ts"
import type { TUIContext } from "./types.ts"

/** A fetch that never answers, but rejects when its signal aborts (as Bun's fetch does). */
const hangingFetch: FetchImpl = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
  })

/** The init of each call of a fetch that answers `{ ok: true }`. */
function recordingFetch(): { fetchImpl: FetchImpl; calls: Array<RequestInit & { unix: string }> } {
  const calls: Array<RequestInit & { unix: string }> = []
  const fetchImpl: FetchImpl = async (_url, init) => {
    calls.push(init)
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  return { fetchImpl, calls }
}

describe("makeBunSocketFetch: time limit", () => {
  test("the default limit is 30 s and ping uses a short limit", () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000)
    expect(PING_TIMEOUT_MS).toBeLessThan(REQUEST_TIMEOUT_MS)
  })

  test("each request has an abort signal and goes to the socket", async () => {
    const { fetchImpl, calls } = recordingFetch()
    const sf = makeBunSocketFetch("/x.sock", fetchImpl)
    const r = await sf("ping")
    expect(r).toEqual({ status: 200, body: { ok: true } })
    expect(calls[0]?.unix).toBe("/x.sock")
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  test("a request with no answer rejects with HelperTimeoutError", async () => {
    const sf = makeBunSocketFetch("/x.sock", hangingFetch)
    const err = await sf("screenshot", {}, { timeoutMs: 20 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HelperTimeoutError)
    const msg = (err as Error).message
    expect(msg).toContain("did not answer in 0.02 s")
    expect(msg).toContain("check the helper log:")
    expect(msg).not.toContain("bun ")
    expect(msg).not.toContain("cud")
  })

  test("another fetch error is not a timeout", async () => {
    const boom: FetchImpl = async () => {
      throw new Error("ECONNREFUSED")
    }
    const err = await makeBunSocketFetch("/x.sock", boom)("ping").catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(HelperTimeoutError)
    expect((err as Error).message).toBe("ECONNREFUSED")
  })

  test("a body that is not JSON gives a null body", async () => {
    const text: FetchImpl = async () => new Response("nope", { status: 500 })
    expect(await makeBunSocketFetch("/x.sock", text)("ping")).toEqual({ status: 500, body: null })
  })
})

/** A tool context for the handler. */
function ctx(input: Record<string, unknown>): TUIContext {
  return {
    trigger: { type: "tool", name: "Computer", input },
    packageDir: "/pkg",
    cwd: "/work",
  } as unknown as TUIContext
}

describe("runWithDeps: time limit and cwd", () => {
  test("a timeout gives a clear tool error", async () => {
    const socketFetch: SocketFetch = async (route) => {
      if (route === "ping") return { status: 200, body: { ok: true } }
      throw new HelperTimeoutError(route, REQUEST_TIMEOUT_MS)
    }
    const r = await runWithDeps(ctx({ action: "screenshot" }), {
      socketFetch,
      ensure: async () => ({ ok: true }),
    })
    expect(r.kind).toBe("tool_result")
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("the helper did not answer in 30 s")
    expect(r.content).toContain("check the helper log:")
    expect(r.content).not.toContain("bun run")
  })

  test("ping goes with the short limit", async () => {
    const seen: Array<number | undefined> = []
    const socketFetch: SocketFetch = async (_route, _body, opts) => {
      seen.push(opts?.timeoutMs)
      return { status: 200, body: { ok: true } }
    }
    await runWithDeps(ctx({ action: "apps" }), {
      socketFetch,
      ensure: async (deps) =>
        (await deps.probe?.()) == null ? { ok: false, header: "x", error: "x" } : { ok: true },
    })
    expect(seen[0]).toBe(PING_TIMEOUT_MS)
    expect(seen[1]).toBeUndefined()
  })

  test("a relative outputDir goes to the daemon as a path in the agent cwd", async () => {
    const bodies: unknown[] = []
    const socketFetch: SocketFetch = async (route, body) => {
      if (route === "screenshot") bodies.push(body)
      return { status: 200, body: { path: "/work/shots/a.png" } }
    }
    await runWithDeps(ctx({ action: "screenshot", outputDir: "shots" }), {
      socketFetch,
      ensure: async () => ({ ok: true }),
    })
    expect(bodies).toEqual([{ outputDir: "/work/shots" }])
  })
})
