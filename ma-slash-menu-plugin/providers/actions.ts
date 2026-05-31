/**
 * Actions provider — the built-in command list.
 *
 * These rows are the host's REGISTERED slash commands, surfaced as `act`
 * items. The list is NOT hardcoded here: that was the old bug — a static
 * `BUILTIN_ACTIONS` array advertised `/config`, `/memory`, `/tasks`, … even
 * though no plugin registered them, so selecting one did nothing. Now we
 * read the live registry the host injects into our handler contexts via
 * `ctx.listCommands()`, so the menu only ever shows commands that actually
 * dispatch.
 *
 * A command provider is therefore just a pure mapping from the host's
 * {@link CommandInfo} shape to the overlay's {@link Item} shape. The state
 * module calls {@link commandItems} with whatever `listCommands()` returned
 * (or `[]` on hosts that predate the command registry).
 *
 * @module ma-slash-menu/providers/actions
 */

import type { CommandInfo } from "../lib/host-types.ts"
import type { Item } from "../lib/types.ts"

/**
 * Map the host's registered commands to menu items. Pure + dependency-free
 * so it's trivially testable. `pluginId` + `argHint` ride along in the
 * payload for the dispatcher / future affordances.
 */
export function commandItems(commands: readonly CommandInfo[]): Item[] {
  return commands.map((c) => ({
    slug: c.name,
    description: c.summary,
    category: "act",
    payload: {
      actionId: c.name,
      kind: "command",
      pluginId: c.pluginId,
      ...(c.argHint ? { argHint: c.argHint } : {}),
    },
  }))
}
