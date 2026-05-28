/**
 * Actions provider — the built-in command list.
 *
 * These are commands the agent's harness understands directly: not
 * skills, not LLM-routed. The dispatcher's `kind: "action"` branch
 * handles each one.
 *
 * To add a new action, append to `BUILTIN_ACTIONS` here AND wire its
 * handler in `lib/dispatch.ts` (or wherever the host harness routes
 * action invocations). The plugin schema is intentionally append-only:
 * existing slugs cannot be renamed without a deprecation window since
 * users build muscle memory around them.
 */

import type { Item, Provider } from "../lib/types.ts"

/** Static built-in actions. Order is alphabetical (also the display order at empty query). */
export const BUILTIN_ACTIONS: Item[] = [
  {
    slug: "clear",
    description: "clear scrollback (history preserved)",
    category: "act",
    payload: { actionId: "clear" },
  },
  {
    slug: "config",
    description: "view or edit user config",
    category: "act",
    payload: { actionId: "config" },
  },
  {
    slug: "context",
    description: "show context window / quota usage",
    category: "act",
    payload: { actionId: "context" },
  },
  {
    slug: "help",
    description: "list keyboard shortcuts & commands",
    category: "act",
    payload: { actionId: "help" },
  },
  {
    slug: "memory",
    description: "manage saved memories",
    category: "act",
    payload: { actionId: "memory" },
  },
  {
    slug: "mode",
    description: "toggle agent mode (default / ask / …)",
    category: "act",
    payload: { actionId: "mode" },
  },
  {
    slug: "quit",
    description: "exit the session (asks once)",
    category: "act",
    payload: { actionId: "quit" },
  },
  {
    slug: "resume",
    description: "browse and resume previous sessions",
    category: "act",
    payload: { actionId: "resume" },
  },
  {
    slug: "skills",
    description: "browse and invoke skills",
    category: "act",
    payload: { actionId: "skills" },
  },
  {
    slug: "tasks",
    description: "show task list",
    category: "act",
    payload: { actionId: "tasks" },
  },
]

/**
 * Default provider. Returns the static list as-is. Future iterations
 * may extend with user-defined aliases from config.
 */
export const actionsProvider: Provider = {
  id: "actions",
  list(): Item[] {
    return BUILTIN_ACTIONS
  },
}

export default actionsProvider
