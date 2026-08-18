/**
 * Fetch GetServerConfig and overlay AgentService base (agentn_url).
 *
 * Field 27 is `aiserver.v1.AgentUrlConfig` with `agent_url` and `agentn_url`.
 * CLI caches this as `serverConfigCache.agentUrlConfig`. Env
 * `MA_CURSOR_AGENT_ENDPOINT` still wins.
 *
 * @module llm/providers/cursor/server-config
 */

import { getServerConfigUrl, overlayAgentBaseUrl } from "./connect/hosts.ts"
import { buildCursorHeaders } from "./headers.ts"
import { loadClientIds } from "./ids.ts"
import { decodeFields, fieldBytes, fieldString } from "./proto/wire.ts"

let inflight: Promise<string | undefined> | undefined
let cached: string | undefined

/** Decode AgentUrlConfig from a GetServerConfigResponse body. */
export function decodeAgentUrlConfig(buf: Uint8Array): { agentUrl?: string; agentnUrl?: string } {
  const out: { agentUrl?: string; agentnUrl?: string } = {}
  for (const field of decodeFields(buf)) {
    if (field.no !== 27) continue
    const nested = fieldBytes(field)
    if (!nested) continue
    for (const inner of decodeFields(nested)) {
      const value = fieldString(inner)?.trim()
      if (!value) continue
      if (inner.no === 1) out.agentUrl = value
      if (inner.no === 2) out.agentnUrl = value
    }
  }
  return out
}

/** Preferred AgentService origin (agentn, then agent). */
export function pickAgentBaseUrl(cfg: {
  agentUrl?: string
  agentnUrl?: string
}): string | undefined {
  const url = (cfg.agentnUrl ?? cfg.agentUrl)?.replace(/\/$/, "")
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:") return undefined
    return url
  } catch {
    return undefined
  }
}

/** Test helper. */
export function resetCursorServerConfigCacheForTests(): void {
  inflight = undefined
  cached = undefined
}

/**
 * Fetch GetServerConfig and overlay the agent base. Cached per process.
 * Soft-fails (returns undefined) on network errors.
 */
export async function ensureCursorServerConfig(token: string): Promise<string | undefined> {
  if (process.env.MA_CURSOR_AGENT_ENDPOINT?.trim()) {
    return process.env.MA_CURSOR_AGENT_ENDPOINT.replace(/\/$/, "")
  }
  if (cached) return cached
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const ids = await loadClientIds()
      const response = await fetch(getServerConfigUrl(), {
        method: "POST",
        headers: buildCursorHeaders({ token, ids, streaming: false, clientType: "cli" }),
        body: new Uint8Array(0),
      })
      if (!response.ok) return undefined
      const buf = new Uint8Array(await response.arrayBuffer())
      const url = pickAgentBaseUrl(decodeAgentUrlConfig(buf))
      if (url) {
        overlayAgentBaseUrl(url)
        cached = url
      }
      return url
    } catch {
      return undefined
    } finally {
      inflight = undefined
    }
  })()
  return inflight
}
