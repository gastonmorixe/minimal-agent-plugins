/**
 * Test helper: a renderer built from the real `prompts.template` provider,
 * bound to this plugin's directory. Tests only. No second engine.
 *
 * @module sub-agents/lib/prompt-test-render
 */

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import createProvider from "../../ma-prompt-template-plugin/provider.ts"

import { type PromptRender } from "./prompts.ts"

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..")
const provider = createProvider()

/** Render a prompt of this plugin through the real provider. */
export const testRender: PromptRender = (name, vars) =>
  provider.render({ pluginId: "ma-sub-agents-plugin", pluginDir: PLUGIN_DIR, name, vars })
