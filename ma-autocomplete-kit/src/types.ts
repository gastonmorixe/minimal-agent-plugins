/**
 * Public types for the autocomplete kit.
 *
 * Decoupled from minimal-agent's plugin loader on purpose: these interfaces
 * describe what providers contribute and what the overlay renderer consumes.
 * Nothing here knows about skills, commands, prompts, or any other feature.
 *
 * # Sigil-agnostic by design
 *
 * The one thing that makes a menu "the skill menu" or "the prompt menu" is a
 * {@link TriggerSpec}. Everything else (scoring, rendering, FSM) is shared.
 * A plugin supplies a spec and a provider and gets a working menu.
 *
 * @module ma-autocomplete-kit/types
 */

/**
 * Three-letter category badge. The `(string & {})` trick keeps the literal
 * autocompletes intact while still allowing arbitrary strings at runtime.
 */
export type Category = "act" | "skl" | (string & {})

/**
 * One row in the menu. Providers emit these.
 *
 * `slug` is the bare identifier (no leading sigil). The renderer decorates
 * with the active trigger sigil.
 */
export interface Item {
  /** Bare identifier without the trigger sigil. e.g. `"config"`, `"review-pr"`. */
  slug: string
  /** Short description shown dim after the slug. */
  description: string
  /** 3-letter badge category. */
  category: Category
  /** Approximate token count of activating this item, if known. */
  tokens?: number
  /**
   * Free-form payload passed back to the dispatcher when this item is
   * invoked. Providers stash whatever they need (file path, body, id).
   * The overlay treats it as opaque.
   */
  payload?: unknown
  /**
   * When true, this item is broken / disabled. Still renderable but
   * flagged red and inert on Enter.
   */
  disabled?: boolean
  /** Human-readable reason for `disabled: true`. Optional. */
  disabledReason?: string
}

/**
 * Source of items. The consumer aggregates providers in declaration order
 * and dedupes by `category + slug`.
 *
 * `list()` should be cheap (cached). Providers re-list on `refreshOn`
 * bus events.
 */
export interface Provider {
  /** Unique id within the plugin (e.g. `"prompts"`, `"skills"`). */
  id: string
  /** Returns the current item set. Called on open and on bus events. */
  list(): Promise<Item[]> | Item[]
  /**
   * Optional list of agent-bus event names that should cause `list()` to
   * be re-invoked between menu opens.
   */
  refreshOn?: string[]
}

/** Factory for the common case of a static list function. */
export function createProvider(
  id: string,
  list: () => Item[] | Promise<Item[]>,
  refreshOn?: string[],
): Provider {
  return refreshOn ? { id, list, refreshOn } : { id, list }
}

/**
 * What a chosen item inserts into the buffer on Enter.
 *
 * - `"name"`: insert the bare slug token (small input, expands at submit).
 * - `"body"`: insert the item's expanded text (payload-driven), via
 *   {@link TriggerSpec.bodyFor}.
 */
export type InsertMode = "name" | "body"

/**
 * The full description of one autocomplete namespace. This is the seam that
 * turns "another sigil" into "another spec" instead of another overlay copy.
 */
export interface TriggerSpec {
  /** The trigger character. e.g. `"&"`, `"$"`, `"@"`. */
  sigil: string
  /**
   * Regex matching the active token ending at the cursor. MUST have two
   * capture groups: (1) the boundary prefix, (2) the query after the sigil.
   * The boundary group is what lets a sigil arm mid-message.
   *
   * Example: `/(^|[\s([{])&([a-zA-Z0-9_-]*)$/`
   */
  tokenRe: RegExp
  /**
   * Whole-text token regex for highlighting every occurrence. Global flag
   * required. Same two-group shape as {@link tokenRe}.
   *
   * Example: `/(^|[\s([{])&([a-zA-Z0-9_-]*)/g`
   */
  spanRe: RegExp
  /**
   * How the menu arms.
   *
   * - `"key"`: a `sigil-typed` event must arrive first. Use this when the host
   *   dispatches the sigil through `editor.key`. The slash sigil and the skill
   *   sigil do this. It prevents the menu opening on pasted text.
   * - `"buffer"`: the menu opens directly from `editor.buffer.changed`. Use
   *   this when the host does NOT dispatch the sigil as a key. The ampersand
   *   and the at-sign are not in the core key-hook set, so they use this.
   *   Default.
   */
  armMode?: "key" | "buffer"
  /** Item categories this menu shows. Empty/undefined means all. */
  categories?: Category[]
  /** Footer verb for Enter. Default `"insert"`. */
  enterVerb?: string
  /** Footer verb for Alt+Enter (insert the body). Omit to hide the hint. */
  bodyVerb?: string
  /** What Enter inserts. Default `"name"`. */
  insertMode?: InsertMode
  /**
   * Resolve the expanded body for an item. Required when `insertMode` is
   * `"body"` or `bodyVerb` is set. Return null to fall back to the name.
   */
  bodyFor?: (item: Item) => string | null
  /** Extra footer chip appended after the standard keys. e.g. `"forced"`. */
  footerNote?: string
  /** SGR color token name for the sigil. Default `"pink"`. */
  sigilColor?: string
}

/** State the overlay renderer consumes. */
export interface OverlayState {
  trigger: string
  /** Buffer text excluding the leading trigger char. */
  query: string
  /** Items already filtered + scored, sorted best-first. */
  items: ScoredItem[]
  /** Index into `items` of the currently selected row. 0 when empty. */
  selectedIndex: number
  /** Window's top row offset into `items`. Driven by visible-row math. */
  scrollOffset: number
  /** Visible-row budget (rows). Default 5. */
  maxRows: number
  /** Terminal cols, drives column drop heuristics. */
  cols: number
  /** Active model's context window size in tokens, for a cost chip. */
  contextWindow?: number
  /** Footer verbs, resolved from the spec by the caller. */
  enterVerb?: string
  bodyVerb?: string
  /** Extra footer chip (spec.footerNote). */
  footerNote?: string
}

/** Item annotated with match score + highlight ranges. */
export interface ScoredItem extends Item {
  /**
   * Match score, larger is better. Composite of: exact-prefix bonus,
   * subsequence density, contiguous-run length.
   */
  score: number
  /**
   * Indexes into `slug` that should be rendered as match-highlighted.
   * Empty when query is empty or when the match was description-only.
   */
  slugMatches: number[]
}
