/**
 * State that the `prompt.submitted` handler and the `SessionTitle` tool
 * share in one process.
 *
 * The loader loads each module handler with `import()`, so the two handlers
 * get the same instance of this module (see the ES module cache). A
 * subprocess handler does not share it, but the plugin has none.
 *
 * @module lib/shared
 */

import type { TitleSessionState } from "./eligibility.ts"

/** A function that sends one event on the plugin event bus. */
export type BusEmit = (event: string, payload?: unknown) => void

/** The shared state of the plugin. */
export interface TitleShared {
  /** The automatic title state of each sid. */
  readonly states: Map<string, TitleSessionState>
  /**
   * The start time (ms) of the last model call of the `SessionTitle` tool for
   * each sid. The tool uses it for the cooldown of the generate path. A failed
   * call also counts. Not in the session files: a new process starts with no
   * value.
   */
  readonly lastRegenerateAt: Map<string, number>
  /**
   * The bus `emit` of the last `prompt.submitted` call. A tool context has no
   * `emit`, so the tool uses this one to send `title.saved`. Undefined until
   * the first event.
   */
  emit?: BusEmit
}

/** Make a new shared state (tests). */
export function createTitleShared(): TitleShared {
  return { states: new Map(), lastRegenerateAt: new Map() }
}

/** The shared state of the real handlers. */
export const defaultTitleShared: TitleShared = createTitleShared()
