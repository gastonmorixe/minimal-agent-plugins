/**
 * Loopback server tests.
 *
 * The server binds a real socket on 127.0.0.1 with port 0 and the test fetches
 * it. A mocked `Bun.serve` would not prove that the redirect URI Google
 * receives is reachable, which is the whole point of the file.
 */
import { afterEach, describe, expect, test } from "bun:test"

import { LOOPBACK_TIMEOUT_MS, type LoopbackServer, startLoopbackServer } from "./loopback-server.ts"

const live: LoopbackServer[] = []

type StartOptions = NonNullable<Parameters<typeof startLoopbackServer>[0]>

function start(opts: StartOptions = {}): LoopbackServer {
  const server = startLoopbackServer(opts)
  live.push(server)
  return server
}

afterEach(() => {
  for (const server of live.splice(0)) server.close()
})

describe("startLoopbackServer", () => {
  test("binds a real port and rejects the authorize redirect URI form Google accepts", () => {
    const server = start()
    expect(server.port).toBeGreaterThan(0)
    expect(server.redirectUri).toBe(`http://localhost:${server.port}/auth/callback`)
    expect(server.redirectUri.startsWith("http://localhost:")).toBe(true)
  })

  test("resolves the code and state of the first good callback", async () => {
    const server = start()
    const pending = server.wait(undefined, 5_000)
    const response = await fetch(`${server.redirectUri}?code=abc123&state=st-1`, {
      redirect: "manual",
    })
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("https://antigravity.google/auth-success")
    await expect(pending).resolves.toEqual({ code: "abc123", state: "st-1" })
  })

  test("uses the caller success URL when one is set", async () => {
    const server = start({ successUrl: "https://example.test/done" })
    const pending = server.wait(undefined, 5_000)
    const response = await fetch(`${server.redirectUri}?code=c&state=s`, { redirect: "manual" })
    expect(response.headers.get("location")).toBe("https://example.test/done")
    await pending
  })

  test("answers 404 for a wrong path and keeps waiting", async () => {
    const server = start()
    const pending = server.wait(undefined, 5_000)
    const wrong = await fetch(`http://localhost:${server.port}/favicon.ico`)
    expect(wrong.status).toBe(404)
    const good = await fetch(`${server.redirectUri}?code=late&state=s`, { redirect: "manual" })
    expect(good.status).toBe(302)
    await expect(pending).resolves.toEqual({ code: "late", state: "s" })
  })

  test("rejects with the provider message when the callback carries an error", async () => {
    const server = start()
    // Collect the rejection without binding it to `expect`: the handler settles
    // the promise while `fetch` is still in flight, and an unobserved rejection
    // would surface as an unhandled error.
    const pending = server.wait(undefined, 2_000).then(
      () => ({ ok: true as const }),
      (error: Error) => ({ ok: false as const, message: error.message }),
    )
    const response = await fetch(
      `${server.redirectUri}?error=access_denied&error_description=User+denied`,
      {
        redirect: "manual",
      },
    )
    expect(response.status).toBe(200)
    const outcome = await pending
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toBe("antigravity login: User denied")
  })

  test("answers 400 when code or state is absent", async () => {
    const server = start()
    const noState = await fetch(`${server.redirectUri}?code=only-code`, { redirect: "manual" })
    expect(noState.status).toBe(400)
    server.close()
  })

  test("rejects on abort and closes the port", async () => {
    const server = start()
    const controller = new AbortController()
    const pending = server.wait(controller.signal, 5_000)
    controller.abort()
    await expect(pending).rejects.toThrow("antigravity login: aborted")
    await expect(fetch(server.redirectUri, { redirect: "manual" })).rejects.toThrow()
  })

  test("rejects after the timeout", async () => {
    const server = start()
    await expect(server.wait(undefined, 25)).rejects.toThrow("timed out waiting for the browser")
  })

  test("a second wait on the same server rejects", async () => {
    const server = start()
    const pending = server.wait(undefined, 5_000)
    await fetch(`${server.redirectUri}?code=a&state=b`, { redirect: "manual" })
    await pending
    await expect(server.wait(undefined, 1_000)).rejects.toThrow("already consumed")
  })

  test("close is safe to call twice", () => {
    const server = start()
    server.close()
    expect(() => server.close()).not.toThrow()
  })

  test("default timeout is five minutes, so a consent screen fits", () => {
    expect(LOOPBACK_TIMEOUT_MS).toBe(300_000)
  })
})
