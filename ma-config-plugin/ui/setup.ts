/**
 * Terminal setup of the config plugin (spec S41). Only the CLI ui-loader
 * runs it. It fills the style slots from the CLI terminal kit.
 *
 * @module ui/setup
 */

import type { UiSetupContext } from "@minimal-agent/core/plugin-api/types/plugin"

import { slots } from "../lib/style.ts"

/** Install the CLI terminal kit into the style slots. */
export default function setup(ctx: UiSetupContext): void {
  slots.install(ctx.tui.kit)
}
