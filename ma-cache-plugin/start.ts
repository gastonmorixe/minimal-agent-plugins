/**
 * Plugin start: attach the cache wire watcher to the host network client.
 *
 * The loader runs this module as a prompt fragment at load time, in every
 * frontend (TUI, print, web, ACP). A prompt fragment is the headless entry
 * that gets `ctx.host`. The fragment returns an empty string, so it adds no
 * text to the system prompt.
 *
 * Diagnostics: each warning goes through `ctx.log.warn`, the plugin logger
 * of the loader. Its source is `cache.anomaly`, at warn severity. The loader
 * routes it to the session of the run that made the request, so each
 * frontend shows it in its own way.
 *
 * @module cache/start
 */

import type { RequestContextSnapshot } from "./detector.ts"
import { CacheAnomalyDetector, type CacheWarnSink } from "./detector.ts"
import { createWireWatch, type WireObserver, type WireRequest } from "./wire-watch.ts"

/** The slice of the fragment context this module reads. */
export interface StartContext {
  log: CacheWarnSink
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
 * the old target does not make a false `no_read_after_write` or
 * `cache_evicted` warning.
 */
export function detectorKeyOf(req: WireRequest, snapshot: RequestContextSnapshot): string {
  let origin = ""
  try {
    origin = new URL(req.url).origin
  } catch {
    // A bad URL gives no endpoint part.
  }
  return [sessionKeyOf(req), snapshot.model, origin].join("\u0000")
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
  const detectorFor = (
    req: WireRequest,
    snapshot: RequestContextSnapshot,
  ): CacheAnomalyDetector => {
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
      })
    }
    detectors.set(key, d)
    return d
  }
  const stop = network.observe(createWireWatch(detectorFor))
  return () => {
    stop()
    attached.delete(network)
  }
}

/** Prompt fragment entry. Returns no prompt text. */
export default function startFragment(ctx: StartContext): string {
  start(ctx)
  return ""
}
