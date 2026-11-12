/**
 * Dev error renderer. Shows the error `kind` and its fields as JSON.
 * This is a dev aid, not user prose.
 *
 * @module ma-host-text-plugin/dev-error-renderer
 */

import { type CoreErrorJson, type ErrorRenderer, isCoreErrorJson } from "@minimal-agent/core/errors"

/** Owner id to pass to `ErrorRendererRegistry.register`. */
export const HOST_TEXT_PLUGIN_ID = "ma-host-text-plugin"

/** Create the dev renderer. It covers every kind and declines input that is not `CoreErrorJson`. */
export function createDevErrorRenderer(): ErrorRenderer {
  return {
    kinds: "*",
    render(err: CoreErrorJson): string | undefined {
      if (!isCoreErrorJson(err)) return undefined
      return `${err.kind} ${JSON.stringify(err.fields)}`
    },
  }
}
