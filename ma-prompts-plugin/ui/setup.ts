/**
 * Terminal setup of the prompts plugin (spec S41). Only the CLI ui-loader
 * runs it. It fills the autocomplete kit's style slots from the CLI
 * terminal kit, so the `@` menu overlay paints with the host styles.
 *
 * @module ui/setup
 */

import type { UiSetupContext } from "@minimal-agent/core/plugin-api/types/plugin"
import { styleSlots } from "ma-autocomplete-kit"

/** Install the CLI terminal kit into the autocomplete kit's style slots. */
export default function setup(ctx: UiSetupContext): void {
  styleSlots.install(ctx.tui.kit)
}
