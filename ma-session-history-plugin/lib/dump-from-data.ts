/**
 * Markdown and XML dump of a session, built in the plugin from the raw
 * messages that `sessions.records` returns. Pure functions.
 *
 * The data-URI scrub is a local port: the host exports no scrub function
 * to plugins. The stub tags match the host.
 *
 * @module plugins/session-history/lib/dump-from-data
 */

import type { BlockLike, SessionRecordsView } from "./host-types.ts"

const MIN_BASE64_CHARS = 256

const DATA_URI_RE =
  /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)((?:;[a-zA-Z0-9=._+-]+)*)?(;base64),([A-Za-z0-9+/=]+)/gi

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kB`
  return `${(n / 1024 / 1024).toFixed(2)}MB`
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

/** Redact oversized `data:*;base64,` URIs. Returns the input when nothing changes. */
export function scrubDumpText(input: string): string {
  if (input.length === 0 || !input.includes("data:")) return input
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
      return (
        `<ma::agent::redacted-asset kind="data_uri" mime="${escapeAttr(mime.toLowerCase())}" ` +
        `size="${escapeAttr(formatBytes(approxBytes))}" chars_removed="${b64.length}" />`
      )
    },
  )
  if (removed === 0) return input
  const withoutPriorFooter = text.replace(/\n*\n<ma::agent::context-sanitizer\b[^>]*\/>\s*$/u, "")
  const footer =
    `<ma::agent::context-sanitizer removed="${removed}" ` +
    `kinds="data_uri" chars_removed="${charsRemoved}" ` +
    `saved="${escapeAttr(formatBytes(savedBytes))}" />`
  return `${withoutPriorFooter}\n\n${footer}`
}

function resultText(block: BlockLike): string {
  const c = block.content
  if (typeof c === "string") return scrubDumpText(c)
  return scrubDumpText(
    (c ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n"),
  )
}

function quote(s: string): string {
  return s
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
}

function sourceDetail(block: BlockLike, textFallback: boolean): string {
  const s = block.source
  if (!s) return ""
  if (s.type === "base64") return s.media_type ?? ""
  if (s.type === "url") return s.url ?? ""
  if (s.type === "file") return s.file_id ?? ""
  return textFallback ? "text/plain" : (s.file_id ?? "")
}

function blockAsMarkdown(block: BlockLike): string {
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
      const contentStr = resultText(block)
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
export function dumpMarkdown(v: SessionRecordsView): string {
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
    if (typeof msg.content === "string") {
      out += `${msg.content}\n\n`
    } else {
      for (const block of msg.content) out += `${blockAsMarkdown(block)}\n\n`
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

function blockAsXml(block: BlockLike, indent: number): string {
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
        `${pad}  <content>${escapeXml(resultText(block))}</content>\n` +
        `${pad}</tool_result>`
      )
    }
    case "image":
      return `${pad}<image source="${escapeXml(block.source?.type ?? "")}" ref="${escapeXml(sourceDetail(block, false))}" />`
    case "document":
      return `${pad}<document source="${escapeXml(block.source?.type ?? "")}" ref="${escapeXml(sourceDetail(block, true))}" />`
    default:
      return `${pad}<unknown>${escapeXml(JSON.stringify(block))}</unknown>`
  }
}

/** XML dump. Same text as the host dump. */
export function dumpXml(v: SessionRecordsView): string {
  let out = ""
  if (v.meta) {
    out += `<session id="${escapeXml(v.meta.sid)}" model="${escapeXml(v.meta.model)}" date="${escapeXml(v.meta.createdAt)}">\n`
  } else {
    out += `<session>\n`
  }
  for (const msg of v.messages) {
    out += `  <turn role="${escapeXml(msg.role)}">\n`
    if (typeof msg.content === "string") {
      out += `    <text>${escapeXml(msg.content)}</text>\n`
    } else {
      for (const block of msg.content) out += `${blockAsXml(block, 4)}\n`
    }
    out += `  </turn>\n`
  }
  out += `</session>\n`
  return out
}
