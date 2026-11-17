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

/** The session key of a request. One key for requests without a session header. */
export function sessionKeyOf(req: WireRequest): string {
  for (const name of SESSION_HEADERS) {
    const v = req.headers[name]
    if (v && v !== "[REDACTED]") return v
  }
  return ""
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
  const detectorFor = (req: WireRequest): CacheAnomalyDetector => {
    const key = sessionKeyOf(req)
    let d = detectors.get(key)
    if (!d) {
      d = new CacheAnomalyDetector({
        sink: ctx.log,
        minPrefixTokens: (model) => models?.find(model)?.capabilities?.caching?.minPrefixTokens,
      })
      detectors.set(key, d)
    }
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
