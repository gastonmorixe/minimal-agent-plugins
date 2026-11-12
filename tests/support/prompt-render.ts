/**
 * Test helper: a prompt renderer built from the real `prompts.template`
 * provider, bound to one plugin directory. Tests only. No second engine.
 *
 * @module tests/support/prompt-render
 */

import createProvider from "../../ma-prompt-template-plugin/provider.ts"

/**
 * Build a render function for one plugin.
 *
 * @param pluginId - Plugin id the provider resolves assets for.
 * @param pluginDir - Absolute directory of that plugin.
 * @returns A function that renders a prompt asset by name.
 */
export function renderFor(
  pluginId: string,
  pluginDir: string,
): (name: string, vars?: Readonly<Record<string, string | number | boolean>>) => string {
  const provider = createProvider()
  return (name, vars) => provider.render({ pluginId, pluginDir, name, ...(vars ? { vars } : {}) })
}
