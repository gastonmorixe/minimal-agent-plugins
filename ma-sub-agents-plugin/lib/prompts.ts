/**
 * Prompt seam for the sub-agents plugin. Every model-facing string the plugin
 * injects into a worker's prompt lives in `../prompts/*.md` and is loaded
 * here, never hardcoded as a TypeScript literal (the repo-wide convention).
 * The files come in through `with { type: "text" }` imports, so Bun inlines
 * them: the same code path works from the on-disk checkout and from a compiled
 * binary, where `import.meta.dir` is `/$bunfs/root` and the files are absent.
 * The pure template helper is re-declared LOCALLY in `./prompt-io.ts` so the
 * plugin imports nothing from the host repo (the decoupling contract).
 * `spawn-plan.ts` and `library.ts` stay pure: they receive already-rendered
 * text.
 *
 * @module sub-agents/lib/prompts
 */

import leafDisciplineMd from "../prompts/leaf-discipline.md" with { type: "text" }
import resultProtocolTmpl from "../prompts/result-protocol.tmpl.md" with { type: "text" }

import { renderTemplate } from "./prompt-io.ts"

/**
 * The REQUIRED deliverable protocol appended to a worker's prompt: how it
 * finishes (write the file itself, then call `ReportResult`), with the manual
 * sentinel path as the documented fallback. `%%resultPath%%` is the exact path
 * the fallback writes to.
 */
export function renderResultProtocol(resultPath: string): string {
  return renderTemplate(
    resultProtocolTmpl,
    { resultPath },
    { source: "prompts/result-protocol.tmpl.md" },
  )
}

/**
 * The shared leaf-worker discipline clause appended to every library
 * specialist's system prompt. Static (no placeholders), so a plain trim.
 */
export function leafDiscipline(): string {
  return leafDisciplineMd.trim()
}
