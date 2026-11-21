/**
 * Render a manifest description as core sends it to the model.
 *
 * A manifest description can hold `%%sideband:...%%` calls. Core expands
 * them with the template engine before the text goes into the tool block, so
 * a request golden has the RENDERED text. A test that compares manifest text
 * with a golden must render the manifest text first, with the real engine
 * (`ma-template-kit`) and the real codec (`tests/support/sideband.ts`).
 *
 * @module tests/ste/render
 */

import type { SidebandApi } from "@minimal-agent/core/host/sideband"

import { expandTemplate } from "../../ma-template-kit/src/index.ts"

/** The start of a sideband call in a template. */
const SIDEBAND_CALL = "%%sideband:"

/**
 * Render the sideband calls of one text. A text with no call stays as it is.
 *
 * @param text - Raw manifest text.
 * @param sb - The real sideband API.
 * @returns The text that the model sees.
 */
export function renderText(text: string, sb: SidebandApi): string {
  return text.includes(SIDEBAND_CALL) ? expandTemplate(text, { sideband: sb }) : text
}

/**
 * Render every string `description` in a JSON value, at any depth (a copy).
 *
 * @param value - A manifest tool block or a schema.
 * @param sb - The real sideband API.
 * @returns A copy with each description rendered.
 */
export function renderDescriptions<T>(value: T, sb: SidebandApi): T {
  if (Array.isArray(value)) return value.map((item) => renderDescriptions(item, sb)) as T
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      key === "description" && typeof child === "string"
        ? renderText(child, sb)
        : renderDescriptions(child, sb),
    ]),
  ) as T
}
