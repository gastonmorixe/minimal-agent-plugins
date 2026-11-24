/**
 * LOCAL structural re-declaration of the host surfaces this plugin
 * consumes. The decoupling contract: a plugin may NOT import host code
 * (`src/...`), not even type-only — it must be able to live in its own
 * repository. So we re-declare exactly the slice of the capability host
 * (`ctx.host`) and the handler context we use; TypeScript's structural
 * typing means the real frozen host satisfies these at runtime.
 *
 * The host-side source of truth for these shapes is
 * `src/plugins/host/capabilities.ts`. Keep field names in lockstep —
 * the integration test (`integration.test.ts`) dispatches through the
 * real loader and fails on drift.
 *
 * @module plugins/session-history/lib/host-types
 */

import type { SidebandApi } from "@minimal-agent/core/plugin-api/types/sideband"

// ---------------------------------------------------------------------------
// sessions:read slice
// ---------------------------------------------------------------------------

export interface SessionIndexEntry {
  readonly sid: string
  readonly createdAt: string
  readonly cwd: string
  readonly model: string
}

export interface SessionLiveness {
  readonly status: "live" | "dead" | "unknown"
  readonly source: string
  readonly pid?: number
  readonly since?: string
  readonly reason?: string
}

/** Structured piece of a record body (data only). */
export interface BodyPart {
  readonly kind: string
  readonly text: string
  readonly toolName: string | null
  readonly role?: string
}

/** Raw kind-specific values of a record. Mirrors host RecordFacts. */
export interface RecordFacts {
  readonly contentIsString: boolean | null
  readonly toolResultCount: number
  readonly textBlockCount: number
  readonly blockCount: number
  readonly toolNames: readonly string[]
  readonly hasText: boolean
  readonly stopReason: string | null
  readonly isError: boolean | null
  readonly toolUseId: string | null
  readonly model: string | null
  readonly cwd: string | null
  readonly compactKind: string | null
  readonly reason: string | null
  readonly messagesBefore: number | null
  readonly messagesAfter: number | null
  readonly rewindTo: string | null
  readonly droppedCount: number | null
  readonly backupSid: string | null
  readonly droppedRecordCount: number | null
  readonly pid: number | null
  readonly hostname: string | null
  readonly round: number | null
}

/** Content block as stored. Loose on purpose: the plugin only reads what it renders. */
export interface BlockLike {
  readonly type: string
  readonly text?: string
  readonly thinking?: string
  readonly signature?: string
  readonly data?: string
  readonly id?: string
  readonly name?: string
  readonly input?: unknown
  readonly tool_use_id?: string
  readonly content?: string | readonly BlockLike[]
  readonly is_error?: boolean
  /** A harness mark (for example the compaction checkpoint): the block is not user text. */
  readonly sideband?: unknown
  readonly source?: {
    readonly type: string
    readonly media_type?: string
    readonly url?: string
    readonly file_id?: string
  }
}

export interface MessageLike {
  readonly role: string
  readonly content: string | readonly BlockLike[]
}

/** Raw records view (host `sessions.records`). */
export interface SessionRecordsView {
  readonly sid: string
  readonly meta: {
    readonly sid: string
    readonly model: string
    readonly createdAt: string
    readonly cwd: string
  } | null
  readonly records: readonly unknown[]
  readonly messages: readonly MessageLike[]
}

export interface SessionMetaView {
  readonly sid: string
  readonly createdAt: string | null
  readonly cwd: string | null
  readonly model: string | null
  readonly agentVersion: string | null
  readonly parentSid: string | null
  readonly recordCount: number
  readonly counts: Readonly<Record<string, number>>
  readonly firstPromptChars: number
  readonly firstPromptParts: readonly string[] | null
  readonly lastActivity: string | null
  readonly liveness: SessionLiveness
  readonly hasTasks: boolean
  readonly hasScratch: boolean
  readonly blobCount: number
}

export interface RecordView {
  readonly index: number
  readonly kind: string
  readonly ts: string | null
  readonly previewChars: number
  readonly parts: readonly BodyPart[]
  readonly facts: RecordFacts
}

export interface RecordWindow {
  readonly sid: string
  readonly items: readonly RecordView[]
  readonly total: number
  readonly firstIndex: number | null
  readonly lastIndex: number | null
}

export interface ToolCallHit {
  readonly index: number
  readonly ts: string | null
  readonly tool: string
  readonly toolUseId: string | null
  readonly inputJson: string | null
  readonly inputPreviewChars: number
}

export interface SearchHit {
  readonly sid: string
  readonly index: number
  readonly ts: string | null
  readonly kind: string
  readonly parts: readonly BodyPart[]
  readonly matchAt: number
  readonly matchLength: number
  readonly previewChars: number
}

export interface SessionsReadApi {
  list(opts?: {
    cwd?: string
    query?: string
    limit?: number
    offset?: number
  }): Promise<{ items: readonly SessionIndexEntry[]; total: number }>
  meta(sid: string): Promise<SessionMetaView | null>
  window(
    sid: string,
    opts: { anchor: "start" | "end"; offset?: number; limit?: number; previewChars?: number },
  ): Promise<RecordWindow | null>
  toolCalls(
    sid: string,
    opts?: { tool?: string; limit?: number; offset?: number; newestFirst?: boolean },
  ): Promise<{ hits: readonly ToolCallHit[]; total: number } | null>
  search(opts: {
    sid?: string
    query: string
    limit?: number
    offset?: number
    previewChars?: number
    maxSessions?: number
    /** Builds the body that the query is matched against, from the raw parts. */
    renderBody?: (parts: readonly BodyPart[]) => string
  }): Promise<{ hits: readonly SearchHit[]; total: number; scannedSessions: number }>
  records(sid: string): Promise<SessionRecordsView | null>
}

// ---------------------------------------------------------------------------
// blobs:read slice
// ---------------------------------------------------------------------------

export interface BlobsReadApi {
  list(
    sid: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<{
    items: readonly { toolUseId: string; bytes: number; mtime: string }[]
    total: number
  }>
  read(
    sid: string,
    toolUseId: string,
    opts?: { maxBytes?: number },
  ): Promise<{ text: string; bytes: number; clipped: boolean; path: string } | null>
}

// ---------------------------------------------------------------------------
// Context slice (what the handler reads off TUIContext)
// ---------------------------------------------------------------------------

export interface PluginHostSlice {
  readonly sessions?: SessionsReadApi
  readonly blobs?: BlobsReadApi
}

export interface ToolTriggerSlice {
  type: "tool"
  name: string
  input: Record<string, unknown>
  tool_use_id: string
}

export interface HandlerContextSlice {
  trigger: { type: string } & Partial<ToolTriggerSlice>
  cwd: string
  host?: PluginHostSlice
  /** The calling session. Mirror of the slice of `AgentContext` this plugin reads. */
  agent?: { readonly sessionId: string }
  /** The session sideband API (`@minimal-agent/core` plugin-api type). It renders the dump stubs. */
  sideband?: SidebandApi
}

export interface ToolResultSlice {
  kind: "tool_result"
  content: string
  is_error?: boolean
  displayHeader?: string
}
