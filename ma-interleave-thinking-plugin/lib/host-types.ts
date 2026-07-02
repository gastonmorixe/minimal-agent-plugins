/**
 * LOCAL structural re-declaration of the host surfaces this plugin consumes.
 *
 * The decoupling contract: an external plugin may NOT import host code
 * (`@minimal-agent/plugin-api` or core `src/...`), not even type-only — it
 * must be able to live in its own repository. So we re-declare exactly the
 * slice of the TUI handler context this plugin touches. TypeScript's types
 * are structural and erased at runtime, so the real host object the loader
 * passes satisfies these at runtime while we type-check standalone.
 *
 * Source of truth in the host: `plugin-api/src/types/plugin.ts`
 * (`TUIContext`, `TUITrigger`, `TUIResult`, `AgentContext`). Keep this narrow
 * and update it if the host contract changes.
 *
 * @module lib/host-types
 */

/** Boot-time agent identity. Mirror of `AgentContext` (we read `sessionId`). */
export interface AgentContext {
  readonly sessionId: string
}

/**
 * The trigger variants this plugin discriminates. Mirror of the host's
 * `TUITrigger` union: we handle the `inline_tag` arm (reading `body`) and
 * collapse the `tool` arm to its discriminant (fields we don't read are
 * omitted). Both arms carry a literal `type` discriminant so the
 * inequality check on the trigger type narrows correctly.
 */
export type TUITrigger = { type: "inline_tag"; body: string } | { type: "tool" }

/**
 * The slice of `TUIContext` this handler reads: the trigger, the working
 * directory, the plugin-scoped env, the optional agent identity, and the
 * stderr sink. Mirror of the host's `TUIContext`.
 */
export interface TUIContext {
  trigger: TUITrigger
  cwd: string
  env: Record<string, string>
  agent?: AgentContext
  stderr: { write(chunk: string): void }
}

/** The `rendered` result variant this handler returns. Mirror of `TUIResult`. */
export type TUIResult = { kind: "rendered"; ansi: string }
