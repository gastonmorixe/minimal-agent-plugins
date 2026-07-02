/**
 * Local type stubs mirroring minimal-agent's plugin contract.
 *
 * External plugins don't sit inside the agent's source tree, so they can't
 * import `@minimal-agent/plugin-api` or core `src/` at runtime, and a plugin
 * should not reach into the agent's modules anyway. TypeScript types are
 * structural and erased at runtime, so a local minimal-slice mirror lets this
 * plugin type-check standalone (bun test, editor IntelliSense) while staying
 * byte-compatible with the agent's real contract.
 *
 * Source of truth in the host: `plugin-api/src/types/plugin.ts`
 * (`PromptFragmentContext`). Keep the slice narrow: mirror only the fields
 * this plugin reads. Update here if the host contract changes.
 *
 * @module lib/host-types
 */

/**
 * Context passed to a prompt-fragment producer. Minimal slice: this plugin
 * reads only `env` (to pull the resolved agent name). The real contract
 * carries more (packageDir, cwd, agent, sessionId); we intentionally omit
 * what we do not consume.
 */
export interface PromptFragmentContext {
  /** Plugin-scoped environment injected by the loader. */
  env?: Record<string, string>
}
