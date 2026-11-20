/**
 * Core {@link TurnNotice} → ACP notice. Two rules from the ACP v1 schema
 * (`Notice`, `NoticeSeverity`, https://agentclientprotocol.com/protocol/v1/schema):
 *
 * - Severity: core uses `"error" | "warn" | "info"`, ACP uses `info`,
 *   `warning`, `error`. So `warn` becomes `warning`. Sending `"warn"` raw is
 *   invalid ACP (spec v3 section 6).
 * - `title` is required, plain text, at least one character. It is built
 *   from the notice kind, never left empty.
 *
 * A `sessionUpdate: "notice"` is sent ONLY when the client advertised
 * `clientCapabilities.session.notices` at `initialize`. Without it the
 * notice is sent as an `agent_message_chunk` with its own `messageId`, so
 * the editor still shows it, apart from the model's reply.
 *
 * @module notices
 */

import type { NoticeSeverity, TurnNotice } from "@minimal-agent/core/sdk/turn-notice"

import { noticeDescription, targetChanges } from "./notice-text.ts"

/** ACP `NoticeSeverity` values this plugin sends. */
export type AcpNoticeSeverity = "info" | "warning" | "error"

/** The body of an ACP `Notice` (the `notice` session update minus its tag). */
export interface AcpNotice {
  readonly severity: AcpNoticeSeverity
  readonly title: string
  readonly description?: string
}

/** Map a core notice severity to the ACP one: `warn` → `warning`, the rest unchanged. */
export function toAcpSeverity(severity: NoticeSeverity): AcpNoticeSeverity {
  switch (severity) {
    case "warn":
      return "warning"
    case "info":
      return "info"
    case "error":
      return "error"
    default: {
      const _exhaustive: never = severity
      throw new Error(`unknown notice severity: ${String(_exhaustive)}`)
    }
  }
}

/** A short, non-empty title per notice kind. Exhaustive: a new kind is a compile error here. */
export function noticeTitle(notice: TurnNotice): string {
  switch (notice.kind) {
    case "refusal":
      return "Response refused"
    case "content_filter":
      return "Response blocked by content filter"
    case "max_tokens_salvaged":
      return "Output limit reached during a tool call"
    case "max_tokens_continuing":
      return "Output limit reached, continuing"
    case "max_tokens_capped":
      return "Output limit reached"
    case "stream_interrupted_salvaged":
      return "Stream interrupted, tool calls kept"
    case "stream_interrupted_continuing":
      return "Stream interrupted, continuing"
    case "stream_interrupted_capped":
      return "Stream interrupted"
    case "ask_denied":
      return "Question skipped"
    case "model_adopted": {
      // A target switch names what changed. One value: its own title.
      const changed = targetChanges(notice)
      const only = changed.length === 1 ? changed[0] : undefined
      if (changed.length > 1) return "Target changed"
      return only
        ? `${only.label[0]?.toUpperCase()}${only.label.slice(1)} changed`
        : "Model changed"
    }
    case "model_adopt_failed":
      return "Model not changed"
    case "stop_hook_capped":
      return "Stop hook limit reached"
    default: {
      const _exhaustive: never = notice
      throw new Error(`unknown notice kind: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

/** Build the ACP notice body for a core notice. The description is the plugin's own plain text. */
export function toAcpNotice(notice: TurnNotice): AcpNotice {
  return {
    severity: toAcpSeverity(notice.severity),
    title: noticeTitle(notice),
    description: noticeDescription(notice),
  }
}

/** Options for {@link noticeUpdate}. */
export interface NoticeUpdateOptions {
  /** True when the client advertised `clientCapabilities.session.notices`. */
  readonly clientNotices: boolean
  /** `messageId` for the `agent_message_chunk` fallback. Unique per notice. */
  readonly fallbackMessageId: string
}

/**
 * The `session/update` `update` object for one notice: a real `notice`
 * when the client supports it, else an `agent_message_chunk` fallback.
 */
export function noticeUpdate(
  notice: AcpNotice,
  options: NoticeUpdateOptions,
): Record<string, unknown> {
  if (notice.title.length === 0) throw new Error("ACP notice title must not be empty")
  if (options.clientNotices) {
    return {
      sessionUpdate: "notice",
      severity: notice.severity,
      title: notice.title,
      ...(notice.description === undefined ? {} : { description: notice.description }),
    }
  }
  const text = notice.description ?? `[${notice.title}]`
  return {
    sessionUpdate: "agent_message_chunk",
    messageId: options.fallbackMessageId,
    content: { type: "text", text: `\n${text}\n` },
  }
}

/** True when `initialize` params advertise `clientCapabilities.session.notices` (an object). */
export function clientSupportsNotices(initializeParams: unknown): boolean {
  const caps = field(initializeParams, "clientCapabilities")
  const notices = field(field(caps, "session"), "notices")
  return typeof notices === "object" && notices !== null && !Array.isArray(notices)
}

function field(x: unknown, key: string): unknown {
  return typeof x === "object" && x !== null ? (x as Record<string, unknown>)[key] : undefined
}
