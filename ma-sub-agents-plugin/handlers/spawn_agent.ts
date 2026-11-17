/**
 * `SpawnAgent` — delegate a unit of work to a background worker. Returns
 * immediately with a handle (the worker runs concurrently); never blocks the
 * lead's loop. Thin wrapper: validate → service → render.
 *
 * @module sub-agents/handlers/spawn_agent
 */

import { serviceDepsFromCtx } from "../lib/handler-deps.ts"
import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { type PromptRender } from "../lib/prompts.ts"
import { renderSpawnDisplay } from "../lib/render.ts"
import { spawnAgent } from "../lib/service.ts"
import type { SubagentRecord } from "../lib/types.ts"
import { parseSpawnRequest } from "../lib/validate.ts"

/**
 * The SPEC R13 line: one extra line when the mode clamp lowered the worker's
 * mode to the lead's live mode. Empty when nothing was lowered. The text lives
 * in `prompts/mode-lowered.tmpl.md`.
 */
function loweredLine(lowered: SubagentRecord["modeLowered"], render: PromptRender): string {
  if (!lowered) return ""
  return `\n${render("mode-lowered.tmpl.md", { from: lowered.from, to: lowered.to }).trim()}`
}

/**
 * The SPEC 6.4 line: one extra line when the worker runs on another provider
 * and got a derived profile without the provider parts. Text lives in
 * `prompts/provider-profile.tmpl.md`.
 */
function providerLine(p: SubagentRecord["profileProvider"], render: PromptRender): string {
  if (!p) return ""
  return `\n${render("provider-profile.tmpl.md", { lead: p.lead, worker: p.worker }).trim()}`
}

/**
 * Tool handler for `SpawnAgent`: validates the delegation request, enforces
 * the nesting ban, provisions the worker session, and launches the
 * background sub-agent process.
 */
export default async function spawn(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "SpawnAgent: unexpected trigger", is_error: true }
  }
  const parsed = parseSpawnRequest(ctx.trigger.input)
  if (!parsed.ok) return { kind: "tool_result", content: parsed.error, is_error: true }

  const deps = serviceDepsFromCtx(ctx)
  if (!deps) {
    return {
      kind: "tool_result",
      content: "SpawnAgent: no session id available. Cannot spawn.",
      is_error: true,
    }
  }

  const r = await spawnAgent(parsed.value, deps)
  if (!r.ok) return { kind: "tool_result", content: r.error, is_error: true }

  const rec = r.value
  const disp = renderSpawnDisplay(rec, true)
  const content =
    `Spawned sub-agent ${rec.id} (${rec.type} · ${rec.model} · ${rec.isolation}), running in background as session ${rec.sid}. ` +
    `It works concurrently. You are not blocked. Track it with SubAgentsListAgents or SubAgentsAgentStatus ${rec.id}. ` +
    `When it finishes you'll get a one-line digest between turns and can pull the full deliverable with SubAgentsAgentResult ${rec.id}.` +
    loweredLine(rec.modeLowered, deps.renderPrompt) +
    providerLine(rec.profileProvider, deps.renderPrompt)
  return {
    kind: "tool_result",
    content,
    displayHeader: disp.header,
    display: disp.body,
    displayFooter: disp.footer,
  }
}
