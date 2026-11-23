/**
 * Markdown and XML dump of a session, built in the plugin from the raw
 * messages that `sessions.records` returns. Pure functions.
 *
 * The data-URI scrub is a local port: the host exports no scrub function
 * to plugins. The codec of the session sideband API writes the stub and
 * footer tags (kinds `redacted-asset` and `context-sanitizer`), so they
 * match the host.
 *
 * @module plugins/session-history/lib/dump-from-data
 */

import type { SidebandApi } from "@minimal-agent/core/plugin-api/types/sideband"

import type { BlockLike, SessionRecordsView } from "./host-types.ts"
import { type PasteReader, pasteMarkdown, pasteXml } from "./paste-refs.ts"

/** The slice of the session sideband API that the scrub and the paste refs use. */
export type DumpSideband = Pick<SidebandApi, "ready" | "render" | "trailing" | "find">

/** Dump options. */
export interface DumpOptions {
  /**
   * Reads the file of a paste ref (`pasteFileReader`). Without it, a paste
   * ref in user text shows as `[Paste #<id> missing]`.
   */
  readPaste?: PasteReader
}

/** A reader that finds no file: each paste ref shows as missing. */
const NO_PASTE: PasteReader = () => null

/** The sideband for the paste step, or undefined with no codec. */
function pasteSb(sb: DumpSideband | undefined): DumpSideband | undefined {
  return sb?.ready ? sb : undefined
}

/** User text with each paste ref as its label and file text (markdown). */
function userTextMarkdown(text: string, sb: DumpSideband | undefined, opts: DumpOptions): string {
  return pasteMarkdown(text, pasteSb(sb), opts.readPaste ?? NO_PASTE)
}

/** User text with each paste ref as a `paste` element (XML content). */
function userTextXml(text: string, sb: DumpSideband | undefined, opts: DumpOptions): string {
  return pasteXml(text, pasteSb(sb), opts.readPaste ?? NO_PASTE, escapeXml)
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
          isUser && block.type === "text"
            ? userTextMarkdown(block.text ?? "", sb, opts)
            : blockAsMarkdown(block, sb)
        out += `${md}\n\n`
      }
    }
  }
  return `${out.trim()}\n`
}

function escapeXml(unsafe: string): string {
  return unsafe
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
          isUser && block.type === "text"
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
