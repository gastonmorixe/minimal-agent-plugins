/**
 * Display style slots of the quota-status plugin (spec S41).
 *
 * The footer renderer reads its styles here. Every slot is plain text
 * until the CLI runs `./setup.ts`, which installs the terminal kit.
 *
 * @module quota-status/ui/style
 */

import { createStyleSlots } from "@minimal-agent/core/plugin-api/utils/style-slots"

/** The style slots of this plugin. */
export const slots = createStyleSlots()
