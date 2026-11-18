/**
 * Plugin start: attach the cache wire watcher to the host network client.
 *
 * The loader runs this module as a prompt fragment at load time, in every
 * frontend (TUI, print, web, ACP). A prompt fragment is the headless entry
 * that gets `ctx.host`. The fragment returns an empty string, so it adds no
 * text to the system prompt.
 *
 * Target switch: a change of credential, provider, model or effort starts a
 * cold cache. The detector key (session, model, endpoint) covers a model or
 * endpoint change. A credential or effort change keeps all three, so the
 * `target.didSwitch` event handler (`on_target_switch.ts`) calls
 * {@link resetAllDetectors}. The host sends that event only in a process with
 * one session (TUI, ACP), so a reset of all detectors is correct there.
 *
 * Diagnostics: each warning (`prefix_changed`, `server_miss`, the cold
 * codes) goes through `ctx.log.warn`, and each info diagnostic
 * (`ttl_expired`) through `ctx.log.info`, the plugin logger of the loader.
 * Its source is `cache.anomaly`. The loader routes it to the session of the
 * run that made the request, so each frontend shows it in its own way (the
 * TUI shows warnings only).
 *
 * Break events: every cache break also goes to the bus as `cache.didBreak`
 * through `ctx.emit` (a {@link CacheBreakPayload}), with the session, model
 * and origin of its history. A frontend shows breaks from this event, not
 * from the log level. A host without `ctx.emit` drops the events.
 *
 * Break diagnostic: every break also writes one diagnostic with source
 * `cache.break` at notice level (`ctx.log.notice`), with the payload message
 * and its scalar fields ({@link breakDiagData}). It is the same fact on the
 * session-routed log, for a host without bus access (ACP turns it into a
 * notice, `ma-acp-plugin/diag-notices.ts`). The TUI does not show notice
 * diagnostics (it uses the bus event), so a break is not shown two times.
 *
 * @module cache/start
 */

import { CACHE_DID_BREAK, type CacheBreakPayload } from "@minimal-agent/core/plugin-api"

import type { CacheDiagData, RequestFacts } from "./detector.ts"
import { CacheAnomalyDetector, type CacheWarnSink } from "./detector.ts"
import { createWireWatch, type WireObserver, type WireRequest } from "./wire-watch.ts"

/** The slice of the fragment context this module reads. */
export interface StartContext {
  /** The plugin logger. `notice` is optional: an older sink has none. */
  log: CacheWarnSink & { notice?(source: string, message: string, sd?: CacheDiagData): void }
  /** Bus emit of the fragment context. Optional: an older host has none. */
  emit?: (channel: string, payload: unknown) => void
  host?: {
    network?: { observe(observer: WireObserver): () => void }
    models?: {
      find(
        idOrAlias: string,
      ): { capabilities?: { caching?: { minPrefixTokens?: number } } } | undefined
    }
  }
}

/** Header that carries the session id of a Messages request. */
const SESSION_HEADERS = ["x-claude-code-session-id", "x-session-id"] as const

/** Network APIs that already have a watcher (a loader can load two times in one process). */
const attached = new WeakSet<object>()

/**
 * Reset functions of the started watchers. Module state: the event handler
 * runs in a different call than the fragment, and both import this module.
 */
const resetters = new Set<() => void>()

/**
 * Forget the history of every detector. The next turn of each key starts
 * fresh. It can hide one warning, and it never makes a false one.
 *
 * @returns The number of watchers that were reset.
 */
export function resetAllDetectors(): number {
  for (const reset of resetters) reset()
  return resetters.size
}

/** Logger source of the break diagnostic. The loader prefixes the plugin id: `cache.break`. */
export const BREAK_SOURCE = "break"

/** Payload fields copied to the break diagnostic, in this order. */
const BREAK_DIAG_FIELDS = [
  "cause",
  "turn",
  "prevTurn",
  "read",
  "written",
  "lost",
  "expectedRead",
  "gapSec",
  "ttlSec",
  "idle",
  "changed",
  "changedIndex",
  "serverReason",
  "serverMissedTokens",
  "requestId",
  "streak",
  "streakLost",
  "actionable",
] as const satisfies readonly (keyof CacheBreakPayload)[]

/** The structured data of the break diagnostic: the scalar payload fields that are set. */
export function breakDiagData(payload: CacheBreakPayload): CacheDiagData {
  const sd: Record<string, string | number | boolean> = {}
  for (const k of BREAK_DIAG_FIELDS) {
    const v = payload[k]
    if (v !== undefined) sd[k] = v
  }
  return sd
}

/** Most detectors kept at one time. The oldest goes first. */
export const MAX_DETECTORS = 64

/** The session key of a request. One key for requests without a session header. */
export function sessionKeyOf(req: WireRequest): string {
  for (const name of SESSION_HEADERS) {
    const v = req.headers[name]
    if (v && v !== "[REDACTED]") return v
  }
  return ""
}

/**
 * The detector key of a request: session, model and endpoint.
 *
 * A cache is for one model on one endpoint. A switch of model, provider or
 * credential starts a cold cache, and the first turn after it reads 0. That
 * is correct, not a problem. With one key for each target, the history of
 * the old target does not make a false `prefix_changed` warning.
 */
export function detectorKeyOf(req: WireRequest, snapshot: RequestFacts): string {
  return [sessionKeyOf(req), snapshot.model, originOf(req)].join("\u0000")
}

/** The endpoint origin of a request, or "" for a bad URL. */
function originOf(req: WireRequest): string {
  try {
    return new URL(req.url).origin
  } catch {
    // A bad URL gives no endpoint part.
    return ""
  }
}

/**
 * Attach the watcher.
 *
 * @returns The function that removes the watcher, or undefined when the host
 *   has no `network:observe` capability or the watcher is already attached.
 */
export function start(ctx: StartContext): (() => void) | undefined {
  const network = ctx.host?.network
  if (!network || attached.has(network)) return undefined
  attached.add(network)
  const models = ctx.host?.models
  const detectors = new Map<string, CacheAnomalyDetector>()
  const detectorFor = (req: WireRequest, snapshot: RequestFacts): CacheAnomalyDetector => {
    const key = detectorKeyOf(req, snapshot)
    let d = detectors.get(key)
    // Delete and set again: the map order is the use order (least recent first).
    if (d) detectors.delete(key)
    else {
      if (detectors.size >= MAX_DETECTORS) {
        const oldest = detectors.keys().next().value
        if (oldest !== undefined) detectors.delete(oldest)
      }
      d = new CacheAnomalyDetector({
        sink: ctx.log,
        minPrefixTokens: (model) => models?.find(model)?.capabilities?.caching?.minPrefixTokens,
        onBreak: (payload: CacheBreakPayload) => {
          ctx.emit?.(CACHE_DID_BREAK, payload)
          ctx.log.notice?.(BREAK_SOURCE, payload.message, breakDiagData(payload))
        },
        history: { sessionId: sessionKeyOf(req), model: snapshot.model, origin: originOf(req) },
      })
    }
    detectors.set(key, d)
    return d
  }
  // Moves on each reset, so a response that was in flight during the reset
  // is not counted in the new history (createWireWatch drops it).
  let epoch = 0
  const stop = network.observe(createWireWatch(detectorFor, () => epoch))
  const reset = () => {
    epoch++
    detectors.clear()
  }
  resetters.add(reset)
  return () => {
    stop()
    resetters.delete(reset)
    attached.delete(network)
  }
}

/** Prompt fragment entry. Returns no prompt text. */
export default function startFragment(ctx: StartContext): string {
  start(ctx)
  return ""
}
