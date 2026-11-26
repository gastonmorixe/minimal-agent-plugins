/**
 * One-shot loopback HTTP server for the OAuth authorization-code redirect.
 *
 * Google's installed-app clients accept `http://localhost:<port>/<path>` for
 * any port, verified against the live authorize endpoint on 2026-11-25 (the
 * client also accepts a portless form). So this server binds port `0`, reads
 * the port the kernel chose, and uses that in the `redirect_uri`. No fixed
 * port means two logins at once, or a busy port, cannot fail the flow.
 *
 * The server answers exactly one request and then closes:
 *
 * 1. `GET <path>?code=..&state=..` resolves {@link LoopbackServer.wait} and
 *    redirects the browser to the success page.
 * 2. `GET <path>?error=..` rejects with the provider message.
 * 3. Anything else gets `404`, and the server keeps waiting.
 *
 * The authorization code is a credential. It is never logged, and the
 * resolved value is held in memory only long enough for the caller to
 * exchange it.
 *
 * @module llm/providers/antigravity/loopback-server
 */

import { ANTIGRAVITY_LOOPBACK_PATH, ANTIGRAVITY_SUCCESS_URL } from "./wire-constants.ts"

/** Result of a callback that carried an authorization code. */
export interface LoopbackResult {
  /** Authorization code from the query. */
  code: string
  /** `state` value the callback echoed. */
  state: string
}

/** A started server, plus the promise for the first good callback. */
export interface LoopbackServer {
  /** Redirect URI to put in the authorize request. Has the real port. */
  redirectUri: string
  /** The real port the kernel assigned. */
  port: number
  /** Resolve on the callback. Reject on abort, timeout, or a provider error. */
  wait(signal?: AbortSignal, timeoutMs?: number): Promise<LoopbackResult>
  /** Stop the server. Safe to call more than once. */
  close(): void
}

/** Default page timeout. The user has 5 minutes to finish a consent screen. */
export const LOOPBACK_TIMEOUT_MS = 5 * 60_000

/**
 * Bytes of a small success page. Loaded with a text import, not from the file
 * system, so a compiled plugin keeps working when its source directory is
 * absent.
 */
const SUCCESS_HTML =
  "<!doctype html><meta charset='utf-8'><title>Signed in</title>" +
  "<body style='font-family:system-ui;padding:3rem'>" +
  "<h1>Signed in</h1><p>You can close this tab and return to the terminal.</p></body>"

interface Pending {
  resolve: (value: LoopbackResult) => void
  reject: (error: Error) => void
}

function abortError(): Error {
  const error = new Error("antigravity login: aborted")
  error.name = "AbortError"
  return error
}

/**
 * Start the one-shot server.
 *
 * `Bun.serve` is the host runtime, so no dependency is added. The `fetch`
 * handler is synchronous and answers every request, including the ones the
 * browser makes on its own (`/favicon.ico`), which would otherwise keep the
 * socket open.
 */
export function startLoopbackServer(
  opts: { path?: string; successUrl?: string; html?: string } = {},
): LoopbackServer {
  const path = opts.path ?? ANTIGRAVITY_LOOPBACK_PATH
  const successUrl = opts.successUrl ?? ANTIGRAVITY_SUCCESS_URL
  const html = opts.html ?? SUCCESS_HTML

  let pending: Pending | null = null
  let settled = false
  let closed = false

  function settle(ok: LoopbackResult | Error): void {
    if (settled) return
    settled = true
    const target = pending
    pending = null
    if (!target) return
    if (ok instanceof Error) target.reject(ok)
    else target.resolve(ok)
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== path || request.method !== "GET") {
        return new Response("Not found", { status: 404 })
      }
      const failure = url.searchParams.get("error")
      if (failure) {
        const description = url.searchParams.get("error_description") ?? failure
        settle(new Error(`antigravity login: ${description}`))
        return new Response("Sign-in failed. Return to the terminal.", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        })
      }
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      if (!code || !state) {
        return new Response("Missing code.", { status: 400 })
      }
      settle({ code, state })
      // The browser is sent to the success page, so the tab closes itself and
      // the user sees the same page that `agy` shows. Close only after the
      // reply is written.
      closeSoon()
      return new Response(html, {
        status: 302,
        headers: { location: successUrl, "content-type": "text/html; charset=utf-8" },
      })
    },
  })

  const port = server.port ?? 0
  const redirectUri = `http://localhost:${port}${path}`

  function close(): void {
    if (closed) return
    closed = true
    try {
      // Graceful stop. A force stop drops the socket before the browser gets
      // the 302 to the success page, and the user then sees a reset instead of
      // the "Signed in" page.
      void server.stop(false)
    } catch {
      // Already stopped by an earlier call or by the runtime.
    }
  }

  /**
   * Stop the server after the current response has been written.
   *
   * `Bun.serve` writes the reply after the handler returns, so an immediate
   * `stop` can close the socket first. One macrotask is enough, and the port is
   * then free for the next login.
   */
  function closeSoon(): void {
    setTimeout(close, 0)
  }

  return {
    redirectUri,
    port,
    close,
    wait(signal?: AbortSignal, timeoutMs: number = LOOPBACK_TIMEOUT_MS): Promise<LoopbackResult> {
      if (signal?.aborted) {
        close()
        return Promise.reject(abortError())
      }
      if (settled) return Promise.reject(new Error("antigravity login: callback already consumed"))
      return new Promise<LoopbackResult>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const onAbort = (): void => settle(abortError())
        const done = (): void => {
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener("abort", onAbort)
        }
        timer = setTimeout(
          () => settle(new Error("antigravity login: timed out waiting for the browser")),
          timeoutMs,
        )
        signal?.addEventListener("abort", onAbort, { once: true })
        pending = {
          resolve: (value) => {
            done()
            resolve(value)
          },
          reject: (error) => {
            done()
            reject(error)
          },
        }
      }).finally(close)
    },
  }
}
