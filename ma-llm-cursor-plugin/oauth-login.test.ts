import { describe, expect, it, spyOn } from "bun:test"

import { completeCursorLogin, createCursorLoginChallenge } from "./oauth-login.ts"

const networkClient = {
  async request(): Promise<never> {
    throw new Error("Secret poll must not use NetworkClient")
  },
}

function challenge() {
  return { ...createCursorLoginChallenge(), pollIntervalMs: 0 }
}

function stall(signal: AbortSignal | null | undefined, url: string): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException(`Request aborted: ${url}`, "AbortError"))
    if (signal?.aborted) abort()
    else signal?.addEventListener("abort", abort, { once: true })
  })
}

describe("Cursor OAuth poll deadline", () => {
  for (const phase of ["headers", "body"] as const) {
    it(`retries three stalled ${phase} requests without leaking the verifier`, async () => {
      const realFetch = globalThis.fetch
      const caller = new AbortController()
      const deadlines: number[] = []
      const timers: ReturnType<typeof setTimeout>[] = []
      const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        deadlines.push(ms)
        const controller = new AbortController()
        timers.push(setTimeout(() => controller.abort(), 1))
        return controller.signal
      })
      const watchdog = setTimeout(() => caller.abort(), 100)
      let calls = 0
      const loginChallenge = challenge()
      globalThis.fetch = (async (url, init) => {
        calls++
        const pending = () => stall(init?.signal, String(url))
        if (phase === "headers") return pending()
        const response = new Response("{}")
        response.json = pending
        return response
      }) as typeof fetch
      try {
        const error = await completeCursorLogin(loginChallenge, {
          networkClient,
          signal: caller.signal,
        }).catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe("Cursor login polling failed after 3 errors")
        expect((error as Error).cause).toBeUndefined()
        expect(String(error)).not.toContain(String(loginChallenge.providerData?.verifier))
        expect(calls).toBe(3)
        expect(deadlines).toEqual([15_000, 15_000, 15_000])
        expect(caller.signal.aborted).toBe(false)
      } finally {
        clearTimeout(watchdog)
        for (const timer of timers) clearTimeout(timer)
        timeout.mockRestore()
        globalThis.fetch = realFetch
      }
    })

    it(`keeps caller cancellation terminal during ${phase} without leaking the URL`, async () => {
      const realFetch = globalThis.fetch
      const caller = new AbortController()
      let calls = 0
      globalThis.fetch = (async (url, init) => {
        calls++
        const pending = () => {
          const result = stall(init?.signal, String(url))
          caller.abort(new Error(`Caller reason: ${String(url)}`))
          return result
        }
        if (phase === "headers") return pending()
        const response = new Response("{}")
        response.json = pending
        return response
      }) as typeof fetch
      try {
        const error = await completeCursorLogin(challenge(), {
          networkClient,
          signal: caller.signal,
        }).catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).name).toBe("AbortError")
        expect((error as Error).message).toBe("Cursor browser login aborted")
        expect((error as Error).cause).toBeUndefined()
        expect(calls).toBe(1)
      } finally {
        globalThis.fetch = realFetch
      }
    })
  }

  it("does not trust a fetch error with the internal polling error prefix", async () => {
    const realFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls++
      throw new Error(`Cursor login polling failed: ${String(url)}`)
    }) as unknown as typeof fetch
    try {
      await expect(completeCursorLogin(challenge(), { networkClient })).rejects.toThrow(
        /^Cursor login polling failed after 3 errors$/,
      )
      expect(calls).toBe(3)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
