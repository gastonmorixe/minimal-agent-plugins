/**
 * Display style slots of the sub-agents plugin (spec S41).
 *
 * Headless code reads its display styles here. Every slot is plain text
 * until the CLI runs `ui/setup.ts`, which installs the terminal kit.
 *
 * @module lib/style-slots
 */

import { createStyleSlots } from "@minimal-agent/core/plugin-api/utils/style-slots"

/** The style slots of this plugin. */
export const slots = createStyleSlots()
