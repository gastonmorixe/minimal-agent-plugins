/**
 * ANSI color helpers for the quota-status footer.
 *
 * The CLI terminal kit gives the styles through `ctx.tui.kit`. The plugin
 * `ui/setup.ts` installs them into the style slots (S41).
 *
 * @module quota-status/colors
 */

import type { TerminalStyles } from "@minimal-agent/core/plugin-api/utils/style-slots"

import { slots } from "./style.ts"

/**
 * The host text styles that the quota footer renders with. It is the live
 * style-slot object (S41): plain until `./setup.ts` installs the CLI kit.
 */
export const c: TerminalStyles = slots.styles
