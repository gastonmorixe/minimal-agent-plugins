/**
 * Route dispatch: turn a validated request into CDP calls against a live
 * `CdpConnection`, returning a JSON-able response. Separated from the HTTP
 * server so it can be tested with a fake-socket-backed connection.
 *
 * @module lib/dispatch
 */

import type { CdpConnection } from "./connection.ts"
import { EVALUATE_PARAMS, extractEvalResult } from "./evaluate.ts"
import type { Route } from "./routes.ts"

export interface DispatchResult {
  status: number
  body: unknown
}

/** Sleep helper (frame auto-attach needs a beat to settle). */
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface DispatchDeps {
  /** Overridable for tests; defaults to the real settle delay. */
  frameSettleMs?: number
}

export async function dispatch(
  conn: CdpConnection,
  route: Route,
  params: Record<string, unknown>,
  wsUrl: string,
  deps: DispatchDeps = {},
): Promise<DispatchResult> {
  const settle = deps.frameSettleMs ?? 1500
  switch (route) {
    case "ping":
      return { status: 200, body: { ok: true, connected: conn.connected, ws: wsUrl } }

    case "targets": {
      const r = await conn.send("Target.getTargets")
      const infos = ((r.result as { targetInfos?: TargetInfo[] })?.targetInfos ?? []).filter(
        (t) => t.type === "page",
      )
      return { status: 200, body: infos.map((t) => slimTarget(t)) }
    }

    case "alltargets": {
      const r = await conn.send("Target.getTargets")
      const infos = (r.result as { targetInfos?: TargetInfo[] })?.targetInfos ?? []
      return {
        status: 200,
        body: infos.map((t) => ({ type: t.type, id: t.targetId, url: clip(t.url, 160) })),
      }
    }

    case "eval": {
      const { target, expr } = params as { target: string; expr: string }
      const sid = await conn.attach(target)
      const r = await conn.send("Runtime.evaluate", { expression: expr, ...EVALUATE_PARAMS }, sid)
      return { status: 200, body: { result: extractEvalResult(r) } }
    }

    case "frameeval": {
      const { target, urlSub, expr } = params as { target: string; urlSub: string; expr: string }
      await conn.attach(target)
      await wait(settle)
      const sid = conn.findFrameSession(urlSub)
      if (!sid) {
        const frames = [...conn.frameSessions.values()].map((v) => v.url)
        return { status: 200, body: { result: { __error: "frame not found", frames } } }
      }
      const r = await conn.send("Runtime.evaluate", { expression: expr, ...EVALUATE_PARAMS }, sid)
      return { status: 200, body: { result: extractEvalResult(r) } }
    }

    case "nav": {
      const { target, url } = params as { target: string; url: string }
      const sid = await conn.attach(target)
      await conn.send("Page.enable", {}, sid).catch(() => {})
      await conn.send("Page.navigate", { url }, sid)
      return { status: 200, body: { ok: true } }
    }

    case "newtab": {
      const { url } = params as { url: string }
      const r = await conn.send("Target.createTarget", { url })
      return { status: 200, body: { id: (r.result as { targetId?: string })?.targetId } }
    }

    case "setdownload": {
      const { target, dir } = params as { target: string; dir: string }
      const sid = await conn.attach(target)
      // Set BOTH scopes: either alone can miss depending on Chrome version.
      await conn.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: dir,
        eventsEnabled: true,
      })
      await conn
        .send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dir }, sid)
        .catch(() => {})
      return { status: 200, body: { ok: true, dir } }
    }

    case "downloads":
      return { status: 200, body: conn.getDownloads() }

    case "send": {
      // Generic CDP passthrough: forward ANY Domain.method with params,
      // optionally scoped to a target's session. This is what unlocks the
      // entire protocol surface (Network, Performance, Tracing, Profiler,
      // HeapProfiler, DOM, Emulation, CSS, Accessibility, …) without the
      // daemon hand-coding each domain.
      const {
        method,
        params: cdpParams,
        sessionId,
        target,
      } = params as {
        method: string
        params: Record<string, unknown>
        sessionId?: string
        target?: string
      }
      // Resolve the session: explicit sessionId wins; else attach the target;
      // else browser-global (no session).
      let sid = sessionId
      if (!sid && target) sid = await conn.attach(target)
      // Enabling an event-bearing domain is the signal the caller wants its
      // event firehose retained — flip recording on automatically so a later
      // `events` poll has something to drain.
      if (/\.enable$/.test(method)) conn.events.setRecording(true)
      try {
        const r = await conn.send(method, cdpParams, sid)
        return { status: 200, body: { result: r.result ?? {}, sessionId: sid ?? null } }
      } catch (e) {
        // A CDP protocol error (bad method, bad params, target gone) comes back
        // as a rejected send. Shape it like the eval error so the model gets a
        // JSON-safe object, not a 500.
        return {
          status: 200,
          body: { result: { __error: e instanceof Error ? e.message : String(e) } },
        }
      }
    }

    case "events": {
      const { filter, since, sessionId, limit, clear } = params as {
        filter?: string
        since?: number
        sessionId?: string
        limit?: number
        clear?: boolean
      }
      const out = conn.events.query({ filter, since, sessionId, limit })
      if (clear) conn.events.clear()
      return {
        status: 200,
        body: {
          recording: conn.events.isRecording,
          cursor: out.cursor,
          buffered: out.buffered,
          dropped: out.dropped,
          count: out.events.length,
          events: out.events,
        },
      }
    }

    case "record": {
      const { on, clear } = params as { on: boolean; clear?: boolean }
      conn.events.setRecording(on)
      if (clear) conn.events.clear()
      return {
        status: 200,
        body: { recording: conn.events.isRecording, buffered: conn.events.query().buffered },
      }
    }

    case "closetarget": {
      const { target } = params as { target: string }
      const r = await conn.send("Target.closeTarget", { targetId: target })
      conn.forgetTarget(target)
      return {
        status: 200,
        body: { ok: (r.result as { success?: boolean })?.success ?? true, target },
      }
    }

    case "activatetarget": {
      const { target } = params as { target: string }
      await conn.send("Target.activateTarget", { targetId: target })
      return { status: 200, body: { ok: true, target } }
    }

    case "getinfo": {
      const { target } = params as { target: string }
      const r = await conn.send("Target.getTargetInfo", { targetId: target })
      return { status: 200, body: (r.result as { targetInfo?: unknown })?.targetInfo ?? {} }
    }
  }
}

interface TargetInfo {
  targetId: string
  type: string
  title?: string
  url?: string
}

function clip(s: string | undefined, n: number): string {
  return (s ?? "").slice(0, n)
}

function slimTarget(t: TargetInfo): { id: string; title: string; url: string } {
  return { id: t.targetId, title: clip(t.title, 80), url: clip(t.url, 160) }
}
