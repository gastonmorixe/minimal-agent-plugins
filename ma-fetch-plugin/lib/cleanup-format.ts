/**
 * One cleanup entry point for every `Fetch` format.
 *
 * | format          | what runs                                                        |
 * |-----------------|------------------------------------------------------------------|
 * | `html`          | `cleanupHtml`: style/script stubs, whitespace, `<pre>` kept      |
 * | `original`      | an HTML document: as `html`. Other bytes: whitespace, `basic`    |
 * | `markdown`      | style/script stubs and space runs outside code (indent kept up   |
 * |                 | to 8), then whitespace at the level                              |
 * | `text`          | same, but the indentation is removed                             |
 * | `links`         | whitespace, at most `basic` (one link per line stays)            |
 * | `accessibility` | whitespace, at most `basic` (JSON: no unicode fold in strings)   |
 * | `value`         | the result of `eval`: same as `accessibility`. The text is data, |
 * |                 | so no space squeeze and no style/script stub                     |
 *
 * `aggressive` folds unicode spaces and drops every blank line. It only runs
 * on the formats that are prose or markup. For the other formats the level is
 * capped at `basic`, because a fold would change values inside a JSON string
 * or a URL.
 *
 * Pure and idempotent. The blob store keeps the bytes before cleanup.
 *
 * @module lib/cleanup-format
 */

import { applyCleanup, type CleanupLevel } from "./cleanup.ts"
import {
  cleanupHtml,
  looksLikeHtml,
  type StubSideband,
  squeezeSpacesOutsideCode,
  stubAssetsInMarkdown,
} from "./html-cleanup.ts"

/**
 * Most spaces of indentation that a markdown line keeps. Nested lists and
 * indented code use up to 8; a deeper indent is layout from the converter.
 */
const MARKDOWN_MAX_INDENT = 8

/**
 * Every kind of text that `Fetch` can return. `value` is the result of an
 * `eval` expression (a JSON value, not a page): see {@link cleanupForFormat}.
 */
export type CleanableFormat =
  | "markdown"
  | "text"
  | "html"
  | "links"
  | "accessibility"
  | "original"
  | "value"

/** `aggressive` becomes `basic`; the other levels stay. */
function capAtBasic(level: CleanupLevel): CleanupLevel {
  return level === "aggressive" ? "basic" : level
}

/** Clean `content` for `format` at `level`. `off` returns the input as it is. */
export function cleanupForFormat(
  content: string,
  format: CleanableFormat,
  level: CleanupLevel,
  sb: StubSideband | undefined,
): string {
  if (level === "off" || content.length === 0) return content
  switch (format) {
    case "html":
      return cleanupHtml(content, level, sb)
    case "markdown":
      return applyCleanup(
        squeezeSpacesOutsideCode(stubAssetsInMarkdown(content, sb), MARKDOWN_MAX_INDENT),
        level,
      )
    case "text":
      return applyCleanup(
        squeezeSpacesOutsideCode(stubAssetsInMarkdown(content, sb), "strip"),
        level,
      )
    case "original":
      return looksLikeHtml(content)
        ? cleanupHtml(content, level, sb)
        : applyCleanup(content, capAtBasic(level))
    case "links":
    case "accessibility":
    case "value":
      return applyCleanup(content, capAtBasic(level))
    default:
      return content
  }
}
