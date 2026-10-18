/**
 * ma-autocomplete-kit: reusable, sigil-agnostic autocomplete menu machinery
 * for minimal-agent plugins.
 *
 * Not a plugin. A plugin supplies a {@link TriggerSpec} and one or more
 * {@link Provider}s and gets the same menu behavior the `$` skill menu has,
 * for any sigil, with no core change and no copy-paste.
 *
 * @module ma-autocomplete-kit
 */

export { CLOSED, type Effect, type Event, type KeyName, type State, type TransitionCtx, type TransitionResult, completeIntoBuffer, filteredItems, offsetToRowCol, paintLines, replaceTokenWithBody, transition } from "./overlay.ts"
export { fuzzyMatch, sortByScore } from "./fuzzy.ts"
export { applySortMode, filterByCategories, scoreItems, type SortMode } from "./scoring.ts"
export { overlayHeight, renderOverlay } from "./render.ts"
export { sigilStyleSpans, type BufferStyleSpan } from "./styles.ts"
export {
  type TokenDeps,
  type TokenSeverity,
  approxTokens,
  approxTokensForFile,
  approxTokensForMany,
  defaultDeps,
  formatTokens,
  tokenSeverity,
} from "./tokens.ts"
export {
  SGR,
  configureSgr,
  dim,
  padLeft,
  padRight,
  resolveSgr,
  sigilTokenSgr,
  stripSgr,
  truncate,
  truncateVisible,
  visualWidth,
  wrap,
} from "./palette.ts"
export {
  type Category,
  type InsertMode,
  type Item,
  type OverlayState,
  type Provider,
  type ScoredItem,
  type TriggerSpec,
  createProvider,
} from "./types.ts"
