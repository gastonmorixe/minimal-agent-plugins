/**
 * The one trust hash of a hook (SPEC.md "Trust": "Each hook's `contentHash`
 * covers its normalized dialect, channel, matcher and handler").
 *
 * Adapters build a {@link HashableHook} from their parsed hook and call
 * {@link hookContentHash}. The function normalizes the input, so key order
 * and default values never change the hash. A change to anything that
 * changes behavior (matcher, filter, command, args, url, timeout, async,
 * failClosed, shell, env, headers) gives a new hash, and a trusted hook
 * becomes untrusted again (review MAJOR 3).
 *
 * Pure: no state, no I/O except the hash.
 *
 * @module engine/hash
 */

import { createHash } from "node:crypto"

import type { HookHandlerSpec } from "./types.ts"

/** The fields of a hook that the trust hash covers. */
export interface HashableHook {
  dialect: string
  /** minimal-agent channel, or `""` for an unsupported event. */
  channel: string
  /** The dialect's own event name (two events can share one channel). */
  event: string
  /** Raw matcher text. `undefined`, `""` and `"*"` all match every value. */
  matcher?: string
  /** An extra dialect filter (the Claude `if` rule). */
  filter?: string
  handler: HookHandlerSpec
  timeoutMs: number
  async: boolean
  failClosed: boolean
}

/** A map with its keys sorted, or undefined when it is empty. */
function sortedMap(m: Record<string, string> | undefined): Array<[string, string]> | undefined {
  if (!m) return undefined
  const entries = Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return entries.length > 0 ? entries : undefined
}

/** The handler with defaults removed and maps sorted. */
function normalHandler(h: HookHandlerSpec): unknown {
  if (h.type === "http") {
    return {
      type: "http",
      url: h.url,
      headers: sortedMap(h.headers) ?? null,
      allowedEnvVars: h.allowedEnvVars?.length ? [...h.allowedEnvVars].sort() : null,
    }
  }
  return {
    type: "command",
    command: h.command,
    // Exec form needs args. An empty list is the shell form (engine/runner.ts commandArgv).
    args: h.args?.length ? [...h.args] : null,
    // `sh` is the default shell.
    shell: h.shell === "bash" ? "bash" : "sh",
    env: sortedMap(h.env) ?? null,
  }
}

/** JSON with object keys sorted at every depth. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`
  if (v && typeof v === "object") {
    const keys = Object.keys(v).sort()
    const o = v as Record<string, unknown>
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`
  }
  return JSON.stringify(v ?? null)
}

/** The normalized form that {@link hookContentHash} hashes (exported for tests). */
export function normalHook(h: HashableHook): unknown {
  const m = h.matcher
  return {
    v: 1,
    dialect: h.dialect,
    channel: h.channel,
    event: h.event,
    matcher: m === undefined || m === "" || m === "*" ? "*" : m,
    filter: h.filter ?? "",
    handler: normalHandler(h.handler),
    timeoutMs: h.timeoutMs,
    async: h.async,
    failClosed: h.failClosed,
  }
}

/** SHA-256 hex of the normalized hook. */
export function hookContentHash(h: HashableHook): string {
  return createHash("sha256")
    .update(canonicalJson(normalHook(h)))
    .digest("hex")
}

/** Hex chars of the identity part of a trust key. */
export const TRUST_KEY_HEX = 8

/** What a hook "is" for its trust key: where it hooks in and what it runs. */
export interface HookIdentity {
  matcher?: string
  filter?: string
  handler: HookHandlerSpec
}

/**
 * Short hex of the hook identity: matcher, filter, and command plus args (or
 * url). Timeout, shell, env, async and failClosed are left out on purpose, so
 * a tuning edit keeps the key (and its enabled flag). The content hash still
 * covers them, so the hook needs re-trust.
 */
export function hookIdentityHash(h: HookIdentity): string {
  const m = h.matcher
  const x = h.handler
  const run = x.type === "http" ? { url: x.url } : { command: x.command, args: x.args ?? [] }
  const id = {
    matcher: m === undefined || m === "" || m === "*" ? "*" : m,
    filter: h.filter ?? "",
    type: x.type,
    ...run,
  }
  return createHash("sha256").update(canonicalJson(id)).digest("hex").slice(0, TRUST_KEY_HEX)
}

/**
 * Stable trust keys for one parsed source file (review MINOR 6). A key is
 * `<dialect>:<sourceId>:<event>:<identity hex>`, so it does not depend on the
 * array position. Inserting a hook before another keeps the other key. Only
 * a second (third, ...) hook with the same identity in one file gets an
 * ordinal suffix `-2` (`-3`, ...).
 */
export class TrustKeyAllocator {
  private readonly seen = new Map<string, number>()

  /**
   * The key for the next hook.
   *
   * @param prefix - `<dialect>:<sourceId>:<event>`.
   * @param id - The hook identity.
   */
  next(prefix: string, id: HookIdentity): string {
    const base = `${prefix}:${hookIdentityHash(id)}`
    const n = (this.seen.get(base) ?? 0) + 1
    this.seen.set(base, n)
    return n === 1 ? base : `${base}-${n}`
  }
}
