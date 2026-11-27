/**
 * The tool error text when the helper binary is missing.
 *
 * Two cases. A dev checkout has the Swift sources, so the author can build the
 * helper. A compiled CLI has no sources and its user has no build tools (no
 * bun, no Xcode, no swiftc), so the text must not ask for a build.
 *
 * @module lib/missing-helper
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

/** The grant sentence. macOS gives the helper the grants of the terminal app. */
export const GRANT_HINT =
  "Give Accessibility and Screen Recording to the terminal app that runs minimal-agent " +
  "(System Settings > Privacy & Security)."

/**
 * True when `packageDir` is a source checkout (it holds `native/Sources`).
 *
 * @param packageDir - The plugin package directory.
 * @param exists - Injectable for tests.
 * @returns True for a dev checkout.
 */
export function isSourceCheckout(
  packageDir: string,
  exists: (p: string) => boolean = existsSync,
): boolean {
  return exists(join(packageDir, "native", "Sources"))
}

/**
 * The error text for a missing helper.
 *
 * @param bin - The helper path that the handler looked for.
 * @param sourceCheckout - True for a dev checkout.
 * @returns The tool error text.
 */
export function missingHelperText(bin: string, sourceCheckout: boolean): string {
  if (sourceCheckout) {
    return (
      `Computer: the helper is not built (${bin}). Build it once in the plugin folder:\n` +
      "  cd ma-computer-use-plugin && bun run bin/cud.ts build\n" +
      `Then: ${GRANT_HINT}`
    )
  }
  return (
    "Computer: this build of minimal-agent does not include the computer-use helper, " +
    "so the Computer tool is not available. Install a release that includes it. " +
    GRANT_HINT
  )
}
