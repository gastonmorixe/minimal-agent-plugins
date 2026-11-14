/**
 * Prompt seam for the sub-agents plugin. Every model-facing string the plugin
 * injects into a worker's prompt lives in `../prompts/*.md`, never as a
 * TypeScript literal. The host renders them through `ctx.prompts.render`
 * (the `prompts.template` provider). This module only names the two prompts
 * and passes the renderer in, so `spawn-plan.ts` and `library.ts` stay pure.
 *
 * @module sub-agents/lib/prompts
 */

/** Render one template of this plugin by file name. Same shape as `ctx.prompts.render`. */
export type PromptRender = (
  name: string,
  vars?: Readonly<Record<string, string | number | boolean>>,
) => string

/**
 * The REQUIRED deliverable protocol appended to a worker's prompt: how it
 * finishes (write the file itself, then call `ReportResult`), with the manual
 * sentinel path as the documented fallback. `%%resultPath%%` is the exact path
 * the fallback writes to.
 */
export function renderResultProtocol(render: PromptRender, resultPath: string): string {
  return render("result-protocol.tmpl.md", { resultPath })
}

/**
 * The shared leaf-worker discipline clause appended to every library
 * specialist's system prompt. Static (no placeholders). The renderer trims.
 */
export function leafDiscipline(render: PromptRender): string {
  return render("leaf-discipline.md").trim()
}
