/**
 * The `prompts.template` provider. Default export is the factory that core
 * calls (see `loadPromptTemplateProvider` in core).
 *
 * @module ma-prompt-template-plugin/provider
 */

import { readFileSync } from "node:fs"
import { join, posix } from "node:path"

import type {
  PromptRenderRequest,
  PromptTemplateProvider,
} from "@minimal-agent/core/plugin-api/types/plugin"

import { renderTemplate } from "./template.ts"

/** Raw file text memoized by absolute path. Prompt files are static per process. */
const fileCache = new Map<string, string>()

/**
 * Read a prompt file, memoized by absolute path. `readPkg` (the host package
 * reader) goes first, so a file of a package embedded in a compiled binary is
 * found. When it is absent or has no such file, the disk is read.
 */
function loadText(absPath: string, readPkg?: () => string | null): string {
  const cached = fileCache.get(absPath)
  if (cached !== undefined) return cached
  const text = readPkg?.() ?? readFileSync(absPath, "utf-8")
  fileCache.set(absPath, text)
  return text
}

/** Render one file by absolute path. Used by `render` and by the parity test. */
export function renderFile(
  absPath: string,
  vars?: PromptRenderRequest["vars"],
  readPkg?: () => string | null,
): string {
  return renderTemplate(loadText(absPath, readPkg), vars ?? {}, { source: absPath })
}

/** Clear the file memo. Tests only. */
export function clearProviderCache(): void {
  fileCache.clear()
}

/** Build the provider. */
export default function createProvider(): PromptTemplateProvider {
  const expand = (text: string): string => text
  return {
    render(req: PromptRenderRequest): string {
      const { readText } = req
      const readPkg =
        readText === undefined ? undefined : () => readText(posix.join("prompts", req.name))
      return expand(renderFile(join(req.pluginDir, "prompts", req.name), req.vars, readPkg))
    },
    expand,
  }
}
