/**
 * Markdown and XML dump of a session, built in the plugin from the raw
 * messages that `sessions.records` returns. Pure functions.
 *
 * The data-URI scrub is a local port: the host exports no scrub function
 * to plugins. The codec of the session sideband API writes the stub and
 * footer tags (kinds `redacted-asset` and `context-sanitizer`), so they
 * match the host.
 *
 * User text (string content, and `text` blocks with no harness mark) goes
 * through `sideband.display` in full mode. Each node with a display (for
 * example a paste ref) shows its label and its text. The kind owner gives
 * the display, so this plugin knows no kind. The display text goes through
 * `neutralize` (the label too), because this dump goes to the model. A text
 * with no node that has a display stays byte for byte the same. The XML
 * escape removes each char that XML 1.0 does not allow, as the host dump
 * does.
 *
 * @module plugins/session-history/lib/dump-from-data
 */

import type {
  SidebandApi,
  SidebandDisplaySegment,
} from "@minimal-agent/core/plugin-api/types/sideband"
import {
  displayMarkdown,
  displayXml,
  xmlSafe,
} from "@minimal-agent/core/plugin-api/utils/display-format"

import type { BlockLike, SessionRecordsView } from "./host-types.ts"

/** The slice of the session sideband API that the scrub and the display step use. */
export type DumpSideband = Pick<
  SidebandApi,
  "ready" | "render" | "trailing" | "find" | "display" | "neutralize"
>

/** Dump options. */
export interface DumpOptions {
  /** The dumped session. Absent: a display handler uses the node attrs only. */
  sid?: string
  /** The largest display text of one node, in UTF-8 bytes. Absent: the handler default. */
  maxBytes?: number
}

/**
 * The display segments of user text, with each display text neutralized.
 * Undefined when no node has a display (or there is no codec): then the
 * caller keeps the text as it is.
 */
function userSegments(
  text: string,
  sb: DumpSideband | undefined,
  opts: DumpOptions,
): SidebandDisplaySegment[] | undefined {
  if (!sb?.ready || typeof sb.display !== "function" || text === "") return undefined
  const { segments, changed } = sb.display(text, {
    mode: "full",
    ...(opts.sid !== undefined ? { sid: opts.sid } : {}),
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  })
  if (!changed) return undefined
  return segments.map((seg) => neutralized(seg, sb))
}

/**
 * A copy of `seg` with its display label and text neutralized. A third-party
 * handler gives the label, and core removes only the control chars. A text
 * segment does not change.
 */
function neutralized(seg: SidebandDisplaySegment, sb: DumpSideband): SidebandDisplaySegment {
  if (seg.type !== "node") return seg
  const display = { ...seg.display, label: sb.neutralize(seg.display.label) }
  if (seg.display.text !== undefined) display.text = sb.neutralize(seg.display.text)
  return { ...seg, display }
}

/** User text with each node that has a display as its label and text (markdown). */
function userTextMarkdown(text: string, sb: DumpSideband | undefined, opts: DumpOptions): string {
  const segments = userSegments(text, sb, opts)
  return segments ? displayMarkdown(segments) : text
}

/** User text with each node that has a display as a `display` element (XML content). */
function userTextXml(text: string, sb: DumpSideband | undefined, opts: DumpOptions): string {
  const segments = userSegments(text, sb, opts)
  return segments ? displayXml(segments, escapeXml) : escapeXml(text)
}

/** True for a `text` block of user text: a harness-marked block is not user text. */
function isUserTextBlock(block: BlockLike): boolean {
  return block.type === "text" && (block.sideband === undefined || block.sideband === null)
}

const MIN_BASE64_CHARS = 256

const DATA_URI_RE =
  /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)((?:;[a-zA-Z0-9=._+-]+)*)?(;base64),([A-Za-z0-9+/=]+)/gi

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kB`
  return `${(n / 1024 / 1024).toFixed(2)}MB`
}

/**
 * `text` without a self-closing `context-sanitizer` footer at its end. The
 * footer must start a line; the line feeds before it go too. Only the last
 * line is parsed.
 */
function withoutFooter(text: string, sb: DumpSideband): string {
  const lineStart = text.trimEnd().lastIndexOf("\n") + 1
  if (lineStart === 0) return text
  const { nodes } = sb.trailing(text.slice(lineStart), { kinds: ["context-sanitizer"] })
  const last = nodes[nodes.length - 1]
  if (last === undefined || !last.selfClosing || last.span.start !== 0) return text
  return text.slice(0, lineStart).replace(/\n+$/u, "")
}

/**
 * Redact oversized `data:*;base64,` URIs. Returns the input when nothing
 * changes. With no `sb` or no codec the input does not change: a stub with
 * no tag would remove data with no notice.
 */
export function scrubDumpText(input: string, sb: DumpSideband | undefined): string {
  if (input.length === 0 || !input.includes("data:") || sb === undefined || !sb.ready) return input
  let removed = 0
  let charsRemoved = 0
  let savedBytes = 0
  const text = input.replace(
    DATA_URI_RE,
    (full, mime: string, _params: string, _flag: string, payload: string) => {
      const b64 = payload.replace(/\s+/g, "")
      if (b64.length < MIN_BASE64_CHARS) return full
      const approxBytes = Math.floor((b64.length * 3) / 4)
      removed++
      charsRemoved += b64.length
      savedBytes += approxBytes
      return sb.render("redacted-asset", {
        attrs: {
          kind: "data_uri",
          mime: mime.toLowerCase(),
          size: formatBytes(approxBytes),
          "chars-removed": b64.length,
        },
      })
    },
  )
  if (removed === 0) return input
  const footer = sb.render("context-sanitizer", {
    attrs: {
      removed,
      kinds: "data_uri",
      "chars-removed": charsRemoved,
      saved: formatBytes(savedBytes),
    },
  })
  return `${withoutFooter(text, sb)}\n\n${footer}`
}

function resultText(block: BlockLike, sb: DumpSideband | undefined): string {
  const c = block.content
  if (typeof c === "string") return scrubDumpText(c, sb)
  return scrubDumpText(
    (c ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n"),
    sb,
  )
}

function quote(s: string): string {
  return s
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
}

/** Raw detail. `undefined` when the field is missing, like core (markdown prints "undefined"). */
function sourceDetail(block: BlockLike, textFallback: boolean): string | undefined {
  const s = block.source
  if (!s) return ""
  if (s.type === "base64") return s.media_type
  if (s.type === "url") return s.url
  if (s.type === "file") return s.file_id
  return textFallback ? "text/plain" : s.file_id
}

function blockAsMarkdown(block: BlockLike, sb: DumpSideband | undefined): string {
  switch (block.type) {
    case "text":
      return block.text ?? ""
    case "thinking": {
      let bq = `> 🤔 **Thinking**\n`
      if (block.thinking) bq += quote(block.thinking)
      else bq += `> *(Redacted thinking, signature: ${(block.signature ?? "").slice(0, 16)}...)*`
      return bq
    }
    case "redacted_thinking":
      return `> 🔒 **Redacted thinking** *(encrypted, ${(block.data ?? "").length} chars)*`
    case "tool_use": {
      let bq = `> 🛠️ **Tool Use**: \`${block.name}\` (id: ${block.id})\n`
      bq += `> \`\`\`json\n`
      bq += quote(JSON.stringify(block.input, null, 2))
      bq += `\n> \`\`\``
      return bq
    }
    case "tool_result": {
      let bq = `> 🔙 **Tool Result**: (id: ${block.tool_use_id})`
      if (block.is_error) bq += ` **[ERROR]**`
      bq += "\n"
      const contentStr = resultText(block, sb)
      if (contentStr) {
        bq += `> \`\`\`\n`
        bq += quote(contentStr)
        bq += `\n> \`\`\``
      } else {
        bq += `> *(Empty result)*`
      }
      return bq
    }
    case "image":
      return `> 🖼️ **Image**: (${block.source?.type} ${sourceDetail(block, false)})`
    case "document":
      return `> 📄 **Document**: (${block.source?.type} ${sourceDetail(block, true)})`
    default:
      return `> *(Unknown block: ${JSON.stringify(block)})*`
  }
}

/** Markdown dump. Same text as the host dump. */
export function dumpMarkdown(
  v: SessionRecordsView,
  sb: DumpSideband | undefined,
  opts: DumpOptions = {},
): string {
  let out = ""
  if (v.meta) {
    out += `# Session: ${v.meta.sid}\n`
    out += `**Model**: ${v.meta.model}\n`
    out += `**Date**: ${v.meta.createdAt}\n`
    out += `**CWD**: \`${v.meta.cwd}\`\n\n`
  }
  for (const msg of v.messages) {
    const role = msg.role === "user" ? "User" : "Assistant"
    out += `## ${role}\n\n`
    const isUser = msg.role === "user"
    if (typeof msg.content === "string") {
      out += `${isUser ? userTextMarkdown(msg.content, sb, opts) : msg.content}\n\n`
    } else {
      for (const block of msg.content) {
        const md =
          isUser && isUserTextBlock(block)
            ? userTextMarkdown(block.text ?? "", sb, opts)
            : blockAsMarkdown(block, sb)
        out += `${md}\n\n`
      }
    }
  }
  return `${out.trim()}\n`
}

/**
 * XML escape. It also removes each char that XML 1.0 does not allow
 * (`xmlSafe`), the same as the host dump.
 */
function escapeXml(unsafe: string): string {
  return xmlSafe(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function blockAsXml(block: BlockLike, indent: number, sb: DumpSideband | undefined): string {
  const pad = " ".repeat(indent)
  switch (block.type) {
    case "text":
      return `${pad}<text>${escapeXml(block.text ?? "")}</text>`
    case "thinking":
      if (block.thinking) return `${pad}<thinking>${escapeXml(block.thinking)}</thinking>`
      return `${pad}<thinking signature="${escapeXml(block.signature ?? "")}"/>`
    case "redacted_thinking":
      return `${pad}<redacted_thinking bytes="${(block.data ?? "").length}"/>`
    case "tool_use": {
      const inputStr =
        typeof block.input === "object" ? JSON.stringify(block.input) : String(block.input)
      return (
        `${pad}<tool_use name="${escapeXml(block.name ?? "")}" id="${escapeXml(block.id ?? "")}">\n` +
        `${pad}  <input>${escapeXml(inputStr)}</input>\n` +
        `${pad}</tool_use>`
      )
    }
    case "tool_result": {
      const isErrorAttr = block.is_error ? ` is_error="true"` : ""
      return (
        `${pad}<tool_result tool_use_id="${escapeXml(block.tool_use_id ?? "")}"${isErrorAttr}>\n` +
        `${pad}  <content>${escapeXml(resultText(block, sb))}</content>\n` +
        `${pad}</tool_result>`
      )
    }
    case "image":
      return `${pad}<image source="${escapeXml(block.source?.type ?? "")}" ref="${escapeXml(sourceDetail(block, false) ?? "")}" />`
    case "document":
      return `${pad}<document source="${escapeXml(block.source?.type ?? "")}" ref="${escapeXml(sourceDetail(block, true) ?? "")}" />`
    default:
      return `${pad}<unknown>${escapeXml(JSON.stringify(block))}</unknown>`
  }
}

/** XML dump. Same text as the host dump. */
export function dumpXml(
  v: SessionRecordsView,
  sb: DumpSideband | undefined,
  opts: DumpOptions = {},
): string {
  let out = ""
  if (v.meta) {
    out += `<session id="${escapeXml(v.meta.sid)}" model="${escapeXml(v.meta.model)}" date="${escapeXml(v.meta.createdAt)}">\n`
  } else {
    out += `<session>\n`
  }
  for (const msg of v.messages) {
    out += `  <turn role="${escapeXml(msg.role)}">\n`
    const isUser = msg.role === "user"
    if (typeof msg.content === "string") {
      const body = isUser ? userTextXml(msg.content, sb, opts) : escapeXml(msg.content)
      out += `    <text>${body}</text>\n`
    } else {
      for (const block of msg.content) {
        const xml =
          isUser && isUserTextBlock(block)
            ? `    <text>${userTextXml(block.text ?? "", sb, opts)}</text>`
            : blockAsXml(block, 4, sb)
        out += `${xml}\n`
      }
    }
    out += `  </turn>\n`
  }
  out += `</session>\n`
  return out
}
