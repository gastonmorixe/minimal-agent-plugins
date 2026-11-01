/**
 * Display style slots of the autocomplete kit (spec S41).
 *
 * The overlay renderer reads its styles here. Every slot is plain text
 * until a plugin that uses the kit installs the CLI terminal kit from its
 * own `ui/setup.ts`: `styleSlots.install(ctx.tui.kit)`.
 *
 * @module ma-autocomplete-kit/style-slots
 */

import { createStyleSlots } from "@minimal-agent/core/plugin-api/utils/style-slots"

/** The style slots of the kit. */
export const slots = createStyleSlots()
