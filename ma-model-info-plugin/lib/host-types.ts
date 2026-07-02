/**
 * Local type stubs mirroring minimal-agent's plugin contract.
 *
 * Source of truth: plugin-api/src/types/plugin.ts. Minimal slice — only
 * fields this plugin uses.
 *
 * External plugins live outside the agent's source tree, so they can't import
 * `@minimal-agent/plugin-api` or core `src/` at runtime. TypeScript types are
 * structural and erased at runtime, so a local minimal-slice mirror lets this
 * plugin type-check standalone while staying byte-compatible with the host.
 *
 * @module lib/host-types
 */

/**
 * Boot-time agent identity. Minimal slice: this plugin reads `sessionId` and
 * `version` (the test also constructs `pid` and `model`, so they are mirrored).
 */
export interface AgentContext {
  readonly sessionId: string
  readonly pid: number
  readonly model: string
  readonly version: string
}

/**
 * Live model + capability snapshot. Full field set: this plugin's report reads
 * essentially every field, so the slice mirrors the whole shape.
 */
export interface ModelInfoSnapshot {
  modelId: string
  displayName: string
  providerId: string
  surfaceId: string
  knowledgeCutoff?: string
  contextWindow: number
  maxOutputTokens: number
  modalities: { image: boolean; audio: boolean; pdf: boolean; video: boolean }
  acceptedInput: { images?: string[]; documents?: string[] }
  thinking: { adaptive: boolean; extended: boolean; visible: boolean; interleaved: boolean }
  effort: { levels: string[]; default: string }
  caching: { explicit: boolean; automatic: boolean; ttls: string[]; reportsCacheHits: boolean }
  tools: { userDefined: boolean; parallel: boolean }
  serverTools: string[]
  pricing: {
    inputPerMTok: number
    outputPerMTok: number
    cacheWritePerMTok: number
    cacheReadPerMTok: number
  }
  resolved: boolean
}

/**
 * Runtime context passed to a module handler. Minimal slice: this plugin reads
 * `cwd`, `agent` (session id + version), and `queryModelInfo`.
 */
export interface TUIContext {
  /** The agent's current working directory. */
  cwd: string
  /** Boot-time agent identity (optional on the legacy back-compat path). */
  agent?: AgentContext
  /** Query the agent's CURRENT model + capabilities, computed live. */
  queryModelInfo?: () => ModelInfoSnapshot | undefined
}

/**
 * Handler result. Minimal slice: this plugin returns only the `tool_result`
 * variant (content, is_error, displayHeader).
 */
export type TUIResult = {
  kind: "tool_result"
  content: string
  is_error?: boolean
  displayHeader?: string
}
