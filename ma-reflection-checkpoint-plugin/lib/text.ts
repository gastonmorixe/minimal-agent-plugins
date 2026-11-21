/**
 * The model-facing texts of the plugin: the system prompt section and the
 * checkpoint attachment. The text lives in `prompts/*.md`. The static text
 * imports make Bun inline it, so the same code works from the checkout and
 * from a compiled binary.
 *
 * @module lib/text
 */

import ackMd from "../prompts/ack.md" with { type: "text" }
import attachmentMd from "../prompts/attachment.tmpl.md" with { type: "text" }
import cooldownMd from "../prompts/checkpoint-cooldown.tmpl.md" with { type: "text" }
import plainMd from "../prompts/checkpoint-plain.tmpl.md" with { type: "text" }
import headingMd from "../prompts/heading.md" with { type: "text" }
import introMd from "../prompts/intro.md" with { type: "text" }

import type { SidebandRender } from "./host-types.ts"

/**
 * Replace each `%%name%%` with `vars[name]`. A name with no value throws, so
 * a template typo cannot reach the model.
 */
export function fill(text: string, vars: Readonly<Record<string, string | number>>): string {
  return text.replace(/%%([A-Za-z0-9_.-]+)%%/g, (_full, name: string) => {
    const value = vars[name]
    if (value === undefined)
      throw new Error(`ma-reflection-checkpoint-plugin: no value for %%${name}%%`)
    return String(value)
  })
}

/** Milliseconds to whole seconds, never below 0. */
export function toSeconds(ms: number): number {
  return Math.max(0, Math.round(ms / 1000))
}

/**
 * The system prompt section that explains the checkpoints and the ack.
 * Returns `""` when `interval` is 0 (the checkpoints are off).
 */
export function loopSafetyText(interval: number, cooldownMs: number): string {
  if (!(interval > 0)) return ""
  const checkpoint =
    cooldownMs > 0
      ? fill(cooldownMd.trim(), { interval, cooldownSec: toSeconds(cooldownMs) })
      : fill(plainMd.trim(), { interval })
  return [headingMd.trim(), "", introMd.trim(), "", checkpoint, "", ackMd.trim()].join("\n")
}

/**
 * The checkpoint attachment: the `reflection-checkpoint` tag line and the
 * reflection prompt, joined by one line feed. The session sideband API
 * renders the tag line (design 40 step 10). With no `sb` or no codec, the
 * tag is "" and the text is the prompt only, with no leading line feed.
 *
 * @param round - The tool round of the checkpoint.
 * @param appliedMs - The wall-clock wait that the plugin applied.
 * @param sb - The session sideband API (`ctx.sideband`).
 */
export function attachmentText(round: number, appliedMs: number, sb?: SidebandRender): string {
  const cooldownSec = toSeconds(appliedMs)
  const tag =
    sb?.render("reflection-checkpoint", {
      attrs: { round, "cooldown-applied-seconds": cooldownSec },
    }) ?? ""
  const prose = fill(attachmentMd.trim(), { round, cooldownSec })
  return tag === "" ? prose : `${tag}\n${prose}`
}
