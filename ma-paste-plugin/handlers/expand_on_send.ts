/**
 * `message.willSend` (priority 100): replace each known paste ref in user
 * text with the wrapped, neutralized file content (PLAN 4.4).
 *
 * Rules:
 * - No codec or no `ctx.host.sessionFiles`: no change.
 * - Only `user` messages: string content and `text` blocks. A text block
 *   with a harness mark (`block.sideband` set, for example the compaction
 *   checkpoint) is skipped: a ref that the model wrote into a summary does
 *   not expand.
 * - Only top-level, self-closing refs with a valid id and a file in this
 *   session expand. All other nodes stay as they are.
 * - `bytes` and `lines` come from the file, never from the typed attrs.
 * - When the model context window is known (`models:read` and the snapshot
 *   model), a paste with more estimated tokens (bytes / 4) than half of the
 *   window does not expand: the ref stays, with one `paste.too-large`
 *   warning for each (sid, id). An unknown window gives no limit.
 * - The rendered form of each (sid, id) stays in a bounded LRU cache (by
 *   bytes and by entries). The files are immutable, so a hit is always
 *   correct, and a send does not read and encode each past paste again.
 * - Copy on change: a changed block, message and messages array are new
 *   objects. Unchanged ones keep their identity. Core computes the output
 *   budget again only when the messages array is new (core B5).
 * - Never throws and never denies.
 *
 * @module handlers/expand_on_send
 */

import type {
  ModelsReadApi,
  SessionFilesApi,
} from "@minimal-agent/core/plugin-api/types/host-capabilities"
import type { HookHandlerContext } from "@minimal-agent/core/plugin-api/types/plugin"
import type { SidebandApi, SidebandNode } from "@minimal-agent/core/plugin-api/types/sideband"

import { countLines, utf8Bytes } from "../lib/count.ts"
import { isPasteId } from "../lib/id.ts"
import { PASTE_KIND } from "../lib/kind.ts"
import { ByteLru, type LruCaps } from "../lib/lru.ts"

export { PASTE_KIND }

const QUERY = { kinds: [PASTE_KIND] } as const

/** The default caps of the render cache: 64 MB and 256 entries. */
export const DEFAULT_RENDER_CACHE_CAPS: Readonly<LruCaps> = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxEntries: 256,
})

/** A paste is too large when its estimated tokens are over this part of the window. */
export const MAX_WINDOW_SHARE = 0.5

/** The estimated bytes of one token. */
export const BYTES_PER_TOKEN = 4

/** The send snapshot fields that this hook reads. Other fields pass through. */
export interface SendSnapshot {
  messages: Array<{ role: string; content: unknown }>
  model?: string
  providerId?: string
  [key: string]: unknown
}

/** The context fields that this hook reads. */
export type ExpandContext = Pick<HookHandlerContext, "sideband" | "host" | "agent" | "log">

/** One cached paste: the rendered wire form and the size of the file. */
interface Rendered {
  text: string
  fileBytes: number
}

/** The `(sid, id)` pairs that already sent a warning (by code) in this process. */
const warned = new Set<string>()

/** The rendered form of each `(sid, id)`. */
const cache = new ByteLru<Rendered>({ ...DEFAULT_RENDER_CACHE_CAPS })

/** Clear the warning memory (tests). */
export function resetMissingWarnings(): void {
  warned.clear()
}

/** Clear the render cache and set its caps (tests). No caps: the defaults. */
export function resetRenderCache(caps: LruCaps = DEFAULT_RENDER_CACHE_CAPS): void {
  cache.clear()
  cache.setCaps({ ...caps })
}

/** The entry count and the bytes of the render cache (tests). */
export function renderCacheStats(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: cache.bytes }
}

interface Expander {
  sb: SidebandApi
  files: SessionFilesApi
  sid: string
  /** The largest file (bytes) that expands, or undefined for no limit. */
  maxFileBytes: number | undefined
  ctx: ExpandContext
}

function key(sid: string, id: string): string {
  return `${sid}\u0000${id}`
}

function warnOnce(x: Expander, code: string, id: string, message: string, extra = {}): void {
  const k = `${code}\u0000${key(x.sid, id)}`
  if (warned.has(k)) return
  warned.add(k)
  try {
    x.ctx.log?.warn(code, message, { id, sid: x.sid, ...extra })
  } catch {
    // A logger must not stop the send.
  }
}

function tooLarge(x: Expander, id: string, bytes: number): boolean {
  if (x.maxFileBytes === undefined || bytes <= x.maxFileBytes) return false
  warnOnce(
    x,
    "paste.too-large",
    id,
    `paste ${id} (${bytes} bytes) is over half of the model context window; the ref goes as text`,
    { bytes },
  )
  return true
}

/** The context window of the snapshot model, or undefined when it is not known. */
function contextWindow(models: ModelsReadApi | undefined, snap: SendSnapshot): number | undefined {
  const model = snap.model
  if (!models || typeof model !== "string" || model === "") return undefined
  const view =
    (typeof snap.providerId === "string" && snap.providerId !== ""
      ? models.findForProvider?.(model, snap.providerId)
      : undefined) ?? models.find?.(model)
  const w = view?.capabilities?.contextWindow
  return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : undefined
}

/** The largest file in bytes that expands for `window`, or undefined (no limit). */
function maxBytesFor(window: number | undefined): number | undefined {
  if (window === undefined) return undefined
  return Math.floor(window * MAX_WINDOW_SHARE * BYTES_PER_TOKEN)
}

/** The new text of one ref node, or undefined to keep the node. */
function expandNode(x: Expander, node: SidebandNode): string | undefined {
  if (!node.selfClosing) return undefined
  const id = node.attrs.id
  if (!isPasteId(id)) return undefined
  const k = key(x.sid, id)
  const hit = cache.get(k)
  if (hit) return tooLarge(x, id, hit.fileBytes) ? undefined : hit.text
  // A stat first: a too-large file is not read.
  const st = x.maxFileBytes === undefined ? null : x.files.stat(x.sid, `${id}.txt`)
  if (st && tooLarge(x, id, st.bytes)) return undefined
  const content = x.files.read(x.sid, `${id}.txt`)
  if (content === null) {
    warnOnce(x, "paste.missing", id, `no file for paste ref ${id}; the ref goes as text`)
    return undefined
  }
  const fileBytes = utf8Bytes(content)
  if (tooLarge(x, id, fileBytes)) return undefined
  const text = x.sb.render(PASTE_KIND, {
    attrs: { id, bytes: fileBytes, lines: countLines(content) },
    body: x.sb.neutralize(content),
  })
  cache.set(k, { text, fileBytes }, utf8Bytes(text))
  return text
}

/** The expanded text, or the same string when nothing changed. */
function expandText(x: Expander, text: string): string {
  if (!x.sb.has(text, QUERY)) return text
  return x.sb.replace(text, (n) => expandNode(x, n), QUERY)
}

/** The new content, or the same value when nothing changed. */
function expandContent(x: Expander, content: unknown): unknown {
  if (typeof content === "string") return expandText(x, content)
  if (!Array.isArray(content)) return content
  let out: unknown[] | undefined
  for (let i = 0; i < content.length; i++) {
    const block = content[i] as { type?: unknown; text?: unknown; sideband?: unknown } | null
    if (!block || typeof block !== "object" || block.type !== "text") continue
    // A harness-marked block (for example the compaction checkpoint) is not user text.
    if (block.sideband !== undefined && block.sideband !== null) continue
    if (typeof block.text !== "string") continue
    const next = expandText(x, block.text)
    if (next === block.text) continue
    out ??= content.slice()
    out[i] = { ...block, text: next }
  }
  return out ?? content
}

/**
 * HookBus `message.willSend` handler (default export for the manifest).
 *
 * @param snap - The outgoing send snapshot. The hook does not change it.
 * @param ctx - The hook context (`host: true` in the manifest).
 * @returns `{payload}` with a new messages array, or undefined (no change).
 */
export default function expandOnSend(
  snap: SendSnapshot,
  ctx: ExpandContext,
): { payload: SendSnapshot } | undefined {
  try {
    const sb = ctx.sideband
    const files = ctx.host?.sessionFiles
    const sid = ctx.agent?.sessionId
    if (!sb?.ready || !files || !sid) return undefined
    if (!snap || !Array.isArray(snap.messages)) return undefined
    const maxFileBytes = maxBytesFor(contextWindow(ctx.host?.models, snap))
    const x: Expander = { sb, files, sid, maxFileBytes, ctx }
    let messages: SendSnapshot["messages"] | undefined
    for (let i = 0; i < snap.messages.length; i++) {
      const m = snap.messages[i]
      if (!m || m.role !== "user") continue
      const content = expandContent(x, m.content)
      if (content === m.content) continue
      messages ??= snap.messages.slice()
      messages[i] = { ...m, content }
    }
    return messages ? { payload: { ...snap, messages } } : undefined
  } catch (e) {
    try {
      ctx.log?.warn(
        "paste.expand",
        `expansion failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    } catch {
      // Never throw.
    }
    return undefined
  }
}
