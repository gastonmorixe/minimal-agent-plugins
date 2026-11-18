/**
 * Shared helpers of the cache plugin tests: a recording sink, turn facts,
 * a driver for one wire request, SSE bodies, and the synthetic request
 * shapes of session bba2ddf4 (requests 086 and 087).
 */

import { gzipSync } from "node:zlib"

import type { CacheFacts, CacheWarnSink } from "../detector.ts"
import type { WireObserver, WireRequest } from "../wire-watch.ts"

/** One recorded diagnostic. */
export interface Warning {
  level: "warn" | "info"
  source: string
  message: string
  sd?: Readonly<Record<string, string | number | boolean>>
}

/** A sink that records each warning and each info diagnostic. */
export function recorder(): CacheWarnSink & { warnings: Warning[]; infos: Warning[] } {
  const warnings: Warning[] = []
  const infos: Warning[] = []
  return {
    warnings,
    infos,
    warn(source, message, sd) {
      warnings.push({ level: "warn", source, message, ...(sd ? { sd } : {}) })
    },
    info(source, message, sd) {
      infos.push({ level: "info", source, message, ...(sd ? { sd } : {}) })
    },
  }
}

/** A large marked prefix. */
export const BIG = { markers: 2, approxPrefixChars: 20_000, model: "m" }

/** Facts of one turn: BIG, with these counts. */
export function f(read: number, write: number, extra: Partial<CacheFacts> = {}): CacheFacts {
  return { ...BIG, read, write, ...extra }
}

/** One Messages request through a watcher. */
export function drive(
  w: WireObserver,
  opts: {
    id: string
    body: unknown
    status?: number
    sse: string
    gzip?: boolean
    session?: string
    url?: string
    resHeaders?: Record<string, string>
    reqHeaders?: Record<string, string>
  },
): void {
  const req: WireRequest = {
    id: opts.id,
    url: opts.url ?? "https://api.example.test/v1/messages",
    method: "POST",
    headers: {
      ...(opts.session ? { "x-claude-code-session-id": opts.session } : {}),
      ...opts.reqHeaders,
    },
    body: JSON.stringify(opts.body),
  }
  w.onRequest?.(req)
  w.onResponse?.(req, { status: opts.status ?? 200, headers: opts.resHeaders ?? {} })
  const bytes = new TextEncoder().encode(opts.sse)
  const payload = opts.gzip ? gzipSync(bytes) : bytes
  // Two chunks, so a split usage line is joined again.
  const mid = Math.floor(payload.byteLength / 2)
  w.onChunk?.(req, payload.slice(0, mid))
  w.onChunk?.(req, payload.slice(mid))
  w.onEnd?.(req)
}

/** A marked request body above the cache minimum. */
export const MARKED = {
  model: "m",
  system: [{ type: "text", text: "x".repeat(20_000), cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "hi" }],
}
/** A response with no cache read and no cache write. */
export const COLD_SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n'

/** One SSE response with these cache counts. */
export function usageSse(read: number, create: number): string {
  return `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":${read},"cache_creation_input_tokens":${create}}}}\n\n`
}

/**
 * Synthetic shape of requests 086 and 087 (session bba2ddf4): the client
 * drops the thinking of the previous latest assistant message, moves the
 * marker to the new last message, and adds two messages.
 */
export const MARK = { type: "ephemeral" }
export const TOOLS = [{ name: "Read", input_schema: { type: "object" } }]
export const SYSTEM = [{ type: "text", text: "x".repeat(20_000), cache_control: MARK }]
export const thinking = (t: string) => ({ type: "thinking", thinking: t, signature: "sig" })
export const toolUse = (id: string) => ({ type: "tool_use", id, name: "Read", input: {} })
export const toolResult = (id: string, marked = false) => ({
  type: "tool_result",
  tool_use_id: id,
  content: `result ${id}`,
  ...(marked ? { cache_control: MARK } : {}),
})
export const REQ_086 = {
  model: "m",
  tools: TOOLS,
  system: SYSTEM,
  messages: [
    { role: "user", content: "start" },
    { role: "assistant", content: [toolUse("a")] },
    { role: "user", content: [toolResult("a")] },
    { role: "assistant", content: [thinking("plan"), toolUse("b")] },
    { role: "user", content: [toolResult("b", true)] },
  ],
}
export const REQ_087 = {
  ...REQ_086,
  messages: [
    ...REQ_086.messages.slice(0, 3),
    { role: "assistant", content: [toolUse("b")] },
    { role: "user", content: [toolResult("b")] },
    { role: "assistant", content: [thinking("next"), toolUse("c")] },
    { role: "user", content: [toolResult("c", true)] },
  ],
}

/** One SSE response with these cache counts and a server miss reason. */
export function missSse(read: number, create: number, reason: string, missed: number): string {
  return `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4,"cache_read_input_tokens":${read},"cache_creation_input_tokens":${create}},"diagnostics":{"cache_miss_reason":{"type":"${reason}","cache_missed_input_tokens":${missed}}}}}\n\n`
}
