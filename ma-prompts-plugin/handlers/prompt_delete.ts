/**
 * Tool-call handler for `PromptDelete`.
 *
 * Deletes a saved prompt. Errors when the name does not exist, so the user
 * gets a clear message instead of a silent no-op.
 *
 * @module handlers/prompt_delete
 */

import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { invalidateItems } from "../lib/menu.ts"
import { deletePrompt } from "../lib/store.ts"

import { depsFor, errResult } from "./shared.ts"

const handler = async (ctx: TUIContext): Promise<TUIResult> => {
  if (ctx.trigger.type !== "tool") return errResult("PromptDelete", "wrong trigger type")
  const name = typeof ctx.trigger.input.name === "string" ? ctx.trigger.input.name.trim() : ""
  if (!name) return errResult("PromptDelete", "`name` is required")

  const result = deletePrompt(depsFor(ctx), name)
  if (!result.ok) return errResult("PromptDelete", result.error)

  invalidateItems()
  return {
    kind: "tool_result",
    content: `Deleted prompt "${name}".`,
    displayHeader: `deleted  ${name}`,
    displayFooter: result.path,
  }
}

export default handler
