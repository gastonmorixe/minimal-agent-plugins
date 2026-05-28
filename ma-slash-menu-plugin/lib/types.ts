/**
 * Public types for ma-slash-menu providers and overlay state.
 *
 * Decoupled from minimal-agent's plugin loader on purpose — these
 * interfaces describe what providers contribute and what the overlay
 * renderer consumes. The loader-side adapter (when core hooks land)
 * is the only piece that needs to translate manifest entries into
 * these shapes.
 */

/** Three-letter category badge displayed at the row's right edge.
 *  The `(string & {})` trick keeps the literal autocompletes intact while
 *  still allowing arbitrary strings at runtime (TS widens `"x" | string`
 *  to `string` and loses the IntelliSense hints). */
export type Category = "act" | "skl" | (string & {})

/**
 * One row in the menu. Providers emit these.
 *
 * `slug` is the bare identifier (no leading `/` or `$`). The renderer
 * decorates with the active trigger sigil.
 */
export interface Item {
  /** Bare identifier without the trigger sigil. e.g. `"config"`, `"swiftui-pro"`. */
  slug: string
  /** Short description shown dim after the slug. */
  description: string
  /** 3-letter badge category. Currently `"act"` or `"skl"`. */
  category: Category
  /** Approximate token count of activating this item, if known. */
  tokens?: number
  /**
   * Free-form payload passed back to the dispatcher when this item is
   * invoked. Providers stash whatever they need (skill path, action id,
   * etc.) here — the overlay treats it as opaque.
   */
  payload?: unknown
  /**
   * When true, this item is broken / disabled (e.g. a skill with a parse
   * error). Still renderable but flagged red and inert on `Enter`.
   */
  disabled?: boolean
  /** Human-readable reason for `disabled: true`. Optional. */
  disabledReason?: string
}

/**
 * Source of items. The loader aggregates providers in declaration order
 * and dedupes by `category + slug`.
 *
 * `list()` should be cheap (cached). Providers re-list on `refreshOn`
 * bus events.
 */
export interface Provider {
  /** Unique id within the plugin (e.g. `"actions"`, `"skills"`). */
  id: string
  /** Returns the current item set. Called on open and on bus events. */
  list(): Promise<Item[]> | Item[]
  /**
   * Optional list of agent-bus event names that should cause `list()` to
   * be re-invoked between menu opens. The loader subscribes and
   * invalidates the cached list.
   */
  refreshOn?: string[]
}

/** Activation trigger — either `/` (mixed, soft) or `$` (skills-only, forced). */
export type Trigger = "/" | "$"

/** State the overlay renderer consumes. */
export interface OverlayState {
  trigger: Trigger
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
  /** Active model's context window size in tokens, for cost-vs-ctx chip. */
  contextWindow?: number
}

/** Item annotated with match score + highlight ranges. */
export interface ScoredItem extends Item {
  /**
   * Match score, larger is better. Composite of: exact-prefix bonus,
   * subsequence density, contiguous-run length, category preference.
   * Items kept in the list have a non-negative score.
   */
  score: number
  /**
   * Indexes into `slug` that should be rendered as match-highlighted.
   * Empty when query is empty (no matches to highlight) or when match
   * happened against description only.
   */
  slugMatches: number[]
}

/**
 * What an `Enter` press resolves to. The dispatcher consumes this and
 * decides what (if anything) to inject into the agent's message stream.
 */
export type Dispatch =
  | {
      kind: "action"
      slug: string
      args: string
      /** Provider-stashed payload, opaque to overlay. */
      payload?: unknown
    }
  | {
      kind: "skill-soft"
      slug: string
      args: string
      /** SKILL.md activation, model-routed (model decides to `Skill read`). */
      payload?: unknown
    }
  | {
      kind: "skill-hard"
      slug: string
      args: string
      /** SKILL.md activation, agent-forced (deterministic load before turn). */
      payload?: unknown
    }
  | {
      kind: "passthrough"
      /** Send the literal buffer text as a normal user message. */
      text: string
    }
  | {
      kind: "abort"
      /** Surface this dim-red message inline, leave buffer unchanged. */
      message: string
    }
