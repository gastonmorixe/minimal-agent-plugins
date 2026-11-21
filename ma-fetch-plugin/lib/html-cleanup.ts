/**
 * Cleanup for `html` fetch output, and the style/script step for markdown.
 *
 * HTML pages carry a lot of text that has no value for the model: big inline
 * `<style>` and `<script>` blocks, long runs of blank lines, and runs of
 * spaces or tabs (indentation). This module removes them.
 *
 *   1. `<style>` and `<script>` blocks become a short stub:
 *        `<ma::agent::redacted-asset kind="style_block" size="11.6KB" tool="Fetch" />`
 *      The tag name and attributes follow the data-URI stub (`lib/data-uri.ts`).
 *      A block is replaced only when the stub is shorter than the block.
 *      `<script type="application/ld+json">` is kept: it is page data.
 *   2. `<pre>` and `<textarea>` blocks are protected. Their whitespace is
 *      part of the content, so nothing inside them changes.
 *   3. On the rest of the page (levels):
 *        "off"        - passthrough.
 *        "basic"      - stubs, a run of 2+ spaces/tabs becomes one space,
 *                       leading and trailing space of each line is removed,
 *                       a run of blank lines becomes one blank line, and
 *                       blank lines at the start and the end are removed.
 *        "aggressive" - basic, then all blank lines are removed.
 *
 * Pure and idempotent: `cleanupHtml(cleanupHtml(x, L), L) === cleanupHtml(x, L)`.
 * The blob store keeps the bytes before cleanup (the `<ma::agent::raw-output>`
 * footer points to them), so the full page can still be read.
 *
 * Limits: this is regex work, not an HTML parser. A `</script>` text inside a
 * JS string ends the block early, and a block with no closing tag is not
 * replaced. Both fail safe: the text stays as it was.
 *
 * @module lib/html-cleanup
 */

import type { SidebandApi } from "@minimal-agent/core/plugin-api/types/sideband"

import type { CleanupLevel } from "./cleanup.ts"

/** The slice of the session sideband API that renders the stubs. */
export type StubSideband = Pick<SidebandApi, "render">

const STYLE_RE = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi
const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi
const PROTECTED_RE = /<(pre|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const LD_JSON_RE = /^<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json/i
/** A markdown code fence (backticks or tildes), up to the closing fence or the end of the text. */
const FENCE_RE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1[`~]*[ \t]*$|(?![\s\S]))/gm
/** An inline code span on one line. */
const INLINE_CODE_RE = /`[^`\n]+`/g

/**
 * The marker border of one call: the shortest run of NUL characters that the
 * input does not contain. A marker is `border + number + border`, so text of
 * the page can never look like one of ours.
 */
function markerBorder(input: string): string {
  let border = "\u0000"
  while (input.includes(border)) border += "\u0000"
  return border
}

/** Size text of a stub: `812B`, `7KB`, `11.6KB`, `1.2MB`. */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")}KB`
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")}MB`
}

/** The stub that replaces a block (kind `redacted-asset`). With no `sb` or no codec, `""`. */
export function assetStub(
  kind: "style_block" | "script_block",
  bytes: number,
  sb: StubSideband | undefined,
): string {
  return (
    sb?.render("redacted-asset", { attrs: { kind, size: sizeText(bytes), tool: "Fetch" } }) ?? ""
  )
}

/**
 * Replace the blocks of one tag with stubs. Keeps a block that is not longer
 * than its stub, and each block when there is no stub (no codec).
 */
function stubBlocks(
  input: string,
  re: RegExp,
  kind: "style_block" | "script_block",
  sb: StubSideband | undefined,
  keep?: (block: string) => boolean,
): string {
  return input.replace(re, (block) => {
    if (keep?.(block)) return block
    const bytes = Buffer.byteLength(block, "utf-8")
    const stub = assetStub(kind, bytes, sb)
    return stub !== "" && stub.length < block.length ? stub : block
  })
}

/** Whitespace work on text that holds no protected block. */
function cleanWhitespace(input: string, level: CleanupLevel): string {
  const lines = input.split("\n").map((l) =>
    l
      .replace(/\r$/, "")
      .replace(/[\t ]{2,}/g, " ")
      .trim(),
  )
  const out: string[] = []
  let prevBlank = false
  for (const l of lines) {
    const blank = l.length === 0
    if (blank && (prevBlank || level === "aggressive")) continue
    out.push(l)
    prevBlank = blank
  }
  while (out.length > 0 && out[0] === "") out.shift()
  while (out.length > 0 && out[out.length - 1] === "") out.pop()
  return out.join("\n")
}

/** Replace each `<style>` and `<script>` block (not JSON-LD) with a stub. */
function stubAssetBlocks(input: string, sb: StubSideband | undefined): string {
  const text = stubBlocks(input, STYLE_RE, "style_block", sb)
  return stubBlocks(text, SCRIPT_RE, "script_block", sb, (b) => LD_JSON_RE.test(b))
}

/**
 * Swap each match of `patterns` for a marker, run `fn`, then put the matches
 * back as they were. The marker border is not in the input (see
 * {@link markerBorder}), so a page with its own NUL text is not changed.
 */
function withProtected(
  input: string,
  patterns: readonly RegExp[],
  fn: (text: string) => string,
): string {
  const border = markerBorder(input)
  const saved: string[] = []
  let text = input
  for (const re of patterns) {
    text = text.replace(re, (block) => {
      saved.push(block)
      return `${border}${saved.length - 1}${border}`
    })
  }
  if (saved.length === 0) return fn(text)
  text = fn(text)
  const markerRe = new RegExp(`\\u0000{${border.length}}(\\d+)\\u0000{${border.length}}`, "g")
  return text.replace(markerRe, (m, i: string) => saved[Number(i)] ?? m)
}

/**
 * Clean an HTML page. See the module comment for the rules of each level.
 * Unknown levels return the input as it is.
 */
export function cleanupHtml(
  input: string,
  level: CleanupLevel,
  sb: StubSideband | undefined,
): string {
  if (level !== "basic" && level !== "aggressive") return input
  if (input.length === 0) return input

  // Stubs first: a script can hold the text "<pre>", and the stub must not
  // be split by the protected-block pass.
  const stubbed = stubAssetBlocks(input, sb)
  return withProtected(stubbed, [PROTECTED_RE], (text) => cleanWhitespace(text, level))
}

/**
 * Replace the `<style>` and `<script>` blocks that a markdown or text page
 * still holds (a converter keeps them as raw HTML). Code fences and inline
 * code are protected: a doc page that shows `<script>` as an example keeps it.
 * Does not touch whitespace. Returns the input when it has no such block.
 */
export function stubAssetsInMarkdown(input: string, sb: StubSideband | undefined): string {
  if (!/<(?:style|script)\b/i.test(input)) return input
  return withProtected(input, [FENCE_RE, INLINE_CODE_RE], (text) => stubAssetBlocks(text, sb))
}

/**
 * Squeeze spaces in markdown or text, outside code fences and inline code:
 * a run of 2+ spaces or tabs inside a line becomes one space, and the
 * indentation at the start of a line is cut. `leading` is `"strip"` (no
 * indentation) or the most spaces to keep (a longer indent is cut to this).
 * Trailing spaces and blank lines are left to `cleanup.ts`.
 */
export function squeezeSpacesOutsideCode(input: string, leading: "strip" | number): string {
  if (!/[ \t]{2,}|^[ \t]/m.test(input)) return input
  return withProtected(input, [FENCE_RE, INLINE_CODE_RE], (text) =>
    text
      .split("\n")
      .map((line) => {
        const indent = /^[ \t]*/.exec(line)?.[0] ?? ""
        const rest = line.slice(indent.length).replace(/[ \t]{2,}/g, " ")
        if (rest.length === 0) return line
        if (leading === "strip") return rest
        return (indent.length > leading ? " ".repeat(leading) : indent) + rest
      })
      .join("\n"),
  )
}

/** True when the text starts like an HTML document (first 2 KB). */
export function looksLikeHtml(input: string): boolean {
  return /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(input.slice(0, 2048))
}
