/**
 * Tool-call handler for `PromptShow`.
 *
 * Returns one prompt's full body. The model-facing content is never
 * truncated; only the transcript preview is clipped.
 *
 * @module handlers/prompt_show
 */

import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { findPrompt, loadPrompts } from "../lib/store.ts"

import { clip, depsFor, errResult } from "./shared.ts"

const PREVIEW_LINES = 14

const handler = async (ctx: TUIContext): Promise<TUIResult> => {
  if (ctx.trigger.type !== "tool") return errResult("PromptShow", "wrong trigger type")
  const name = typeof ctx.trigger.input.name === "string" ? ctx.trigger.input.name.trim() : ""
  if (!name) return errResult("PromptShow", "`name` is required")

  const result = loadPrompts(depsFor(ctx))
  const prompt = findPrompt(result, name)
  if (!prompt) {
    const available = result.prompts.map((p) => p.slug).join(", ")
    return errResult(
      "PromptShow",
      `no prompt named "${name}".${available ? ` Available: ${available}` : " The library is empty."}`,
    )
  }

  const lines = prompt.body.split("\n")
  const preview = lines.slice(0, PREVIEW_LINES).map((l) => clip(l, 200))
  if (lines.length > PREVIEW_LINES) {
    preview.push(`… (${lines.length - PREVIEW_LINES} more lines)`)
  }

  return {
    kind: "tool_result",
    content: prompt.body,
    displayHeader: `show  ${prompt.slug}  (${prompt.scope})`,
    display: preview.join("\n"),
    displayFooter: prompt.path,
    _truncCtx: {
      totalBytes: Buffer.byteLength(prompt.body, "utf-8"),
      totalLines: lines.length,
      tool: "PromptShow",
    },
  }
}

export default handler
