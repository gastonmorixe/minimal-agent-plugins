/**
 * Tool-call handler for `PromptList`.
 *
 * Lists every saved prompt with name, description, scope, and path. Also
 * reports broken files so one bad file is visible and fixable.
 *
 * @module handlers/prompt_list
 */

import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { loadPrompts } from "../lib/store.ts"

import { clip, depsFor, errResult } from "./shared.ts"

const handler = async (ctx: TUIContext): Promise<TUIResult> => {
  if (ctx.trigger.type !== "tool") return errResult("PromptList", "wrong trigger type")

  const { prompts, broken } = loadPrompts(depsFor(ctx))

  const content = JSON.stringify(
    {
      prompts: prompts.map((p) => ({
        name: p.slug,
        description: p.description,
        scope: p.scope,
        path: p.path,
      })),
      broken: broken.map((b) => ({ name: b.slug, path: b.path, errors: b.errors })),
    },
    null,
    2,
  )

  if (prompts.length === 0 && broken.length === 0) {
    return {
      kind: "tool_result",
      content,
      displayHeader: "list  0 prompts",
      display: "(no saved prompts yet)",
    }
  }

  const lines: string[] = []
  for (const p of prompts) {
    lines.push(`  ${p.slug}  ${clip(p.description, 70)}`)
  }
  for (const b of broken) {
    lines.push(`  ${b.slug}  (broken: ${b.errors[0] ?? "unknown"})`)
  }

  return {
    kind: "tool_result",
    content,
    displayHeader: `list  ${prompts.length} prompts${broken.length > 0 ? ` · ${broken.length} broken` : ""}`,
    display: lines.join("\n"),
  }
}

export default handler
