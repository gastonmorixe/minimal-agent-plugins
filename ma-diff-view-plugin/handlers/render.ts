/**
 * The diff-view plugin's renderer (S41).
 *
 * The colorizer lives in the CLI terminal-kit. The plugin gets it through
 * its style slots: `ui/setup.ts` installs the kit in the CLI. Without the
 * CLI, the renderer returns the patch as plain text, with the title line
 * on top when there is one.
 *
 * @module diff-view/handlers/render
 */

import { slots } from "../lib/style.ts"

/** Render a unified diff patch for the transcript. */
export function renderUnifiedDiff(patch: string, title?: string): string {
  if (slots.installed() || !title) return slots.renderUnifiedDiff(patch, title)
  return `${title}\n${patch}`
}
