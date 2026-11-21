/**
 * The model-facing texts of the plugin: the system prompt section and the
 * checkpoint attachment. The text lives in `prompts/*.md`. The static text
 * imports make Bun inline it, so the same code works from the checkout and
 * from a compiled binary.
 *
 * The prompt files are templates: `%%name%%` vars and `%%sideband:...%%`
 * calls (design 50 section 1). The plugin does not fill them. It returns a
 * `PromptTemplateText` (`{ template, vars }`, the fragment, S4) or a hook
 * template entry (`{ text, template: true, vars }`, S7), and core renders it
 * at its point of use.
 *
 * @module lib/text
 */

import ackMd from "../prompts/ack.md" with { type: "text" }
import attachmentMd from "../prompts/attachment.tmpl.md" with { type: "text" }
import cooldownMd from "../prompts/checkpoint-cooldown.tmpl.md" with { type: "text" }
import plainMd from "../prompts/checkpoint-plain.tmpl.md" with { type: "text" }
import headingMd from "../prompts/heading.md" with { type: "text" }
import introMd from "../prompts/intro.md" with { type: "text" }

import type { HookTemplateEntry, PromptTemplateText, SidebandRender } from "./host-types.ts"

/** Milliseconds to whole seconds, never below 0. */
export function toSeconds(ms: number): number {
  return Math.max(0, Math.round(ms / 1000))
}

/**
 * The system prompt section that explains the checkpoints and the ack, as a
 * template that core renders (vars `interval` and, with a cooldown,
 * `cooldownSec`). Returns `""` when `interval` is 0 (the checkpoints are off).
 */
export function loopSafetyText(interval: number, cooldownMs: number): PromptTemplateText | "" {
  if (!(interval > 0)) return ""
  const cooldown = cooldownMs > 0
  const checkpoint = (cooldown ? cooldownMd : plainMd).trim()
  return {
    template: [headingMd.trim(), "", introMd.trim(), "", checkpoint, "", ackMd.trim()].join("\n"),
    vars: cooldown ? { interval, cooldownSec: toSeconds(cooldownMs) } : { interval },
  }
}

/**
 * The checkpoint attachment template: the `reflection-checkpoint` tag line
 * and the reflection prompt, joined by one line feed. The session sideband
 * API renders the tag line here (design 40 step 10; code, not a prompt
 * file). The prompt part holds `%%name%%` vars and `%%sideband:...%%` calls
 * that core renders (see {@link attachmentEntry}). With no `sb` or no codec,
 * the tag is "" and the text is the prompt only, with no leading line feed.
 *
 * @param round - The tool round of the checkpoint.
 * @param appliedMs - The wall-clock wait that the plugin applied.
 * @param sb - The session sideband API (`ctx.sideband`).
 */
export function attachmentText(round: number, appliedMs: number, sb?: SidebandRender): string {
  const tag =
    sb?.render("reflection-checkpoint", {
      attrs: { round, "cooldown-applied-seconds": toSeconds(appliedMs) },
    }) ?? ""
  const prose = attachmentMd.trim()
  // The tag line is rendered output: escape `%%` so the template pass keeps it.
  const head = tag.replaceAll("%%", "%%%%")
  return head === "" ? prose : `${head}\n${prose}`
}

/**
 * The checkpoint attachment as a hook context entry that core renders (S7):
 * the hook form of `PromptTemplateText` (`{ text, template: true, vars }`)
 * with the vars `round` and `cooldownSec`.
 *
 * @param round - The tool round of the checkpoint.
 * @param appliedMs - The wall-clock wait that the plugin applied.
 * @param sb - The session sideband API (`ctx.sideband`).
 */
export function attachmentEntry(
  round: number,
  appliedMs: number,
  sb?: SidebandRender,
): HookTemplateEntry {
  return {
    text: attachmentText(round, appliedMs, sb),
    template: true,
    vars: { round, cooldownSec: toSeconds(appliedMs) },
  }
}
