/**
 * Prompt-fragment producer for the `agent-identity` plugin.
 *
 * Emits a SINGLE system-prompt line naming the agent, e.g.
 *
 *   Your name in this session is Laura. Use this name when a person speaks to you.
 *
 * The fixed words live in `prompts/identity.md`, so the STE gate reads them.
 * The name goes in through the `%%name%%` var. The static text import makes
 * Bun inline the file, so the same code works in a compiled binary.
 *
 * or nothing at all when naming is explicitly disabled (an off sentinel;
 * naming is otherwise on by default and resolves to `auto`). The name is
 * resolved once at boot in the host (`resolveAgentName`) and published as
 * `MINIMAL_AGENT_AGENT_NAME`; the loader spreads `process.env` into this
 * fragment's `ctx.env`, so we just read the already-resolved value here. No
 * hashing or config parsing happens in the plugin: the host owns that so the
 * value is identical everywhere (system prompt, future intercom/fleet labels).
 *
 * CACHE NOTE: this fragment lands in the composed plugin block, which is the
 * agent's per-session `sessionContext` system block, AFTER the cross-session
 * `scope:"global"` cache breakpoint on the instructions block. So the name
 * rides in already-variable, already-uncached-across-sessions content and
 * costs zero shared-prefix cache. See this plugin's README for the full
 * rationale. The producer is pure + synchronous + deterministic, so the
 * composed system prompt stays byte-stable for the whole session (the loader
 * memoizes the block on first assembly).
 *
 * @module handlers/identity
 */

import type { PromptFragmentContext } from "../lib/host-types.ts"
import identityMd from "../prompts/identity.md" with { type: "text" }

/** Env var the host publishes with the resolved, frozen session name. */
const NAME_ENV = "MINIMAL_AGENT_AGENT_NAME"

/** The `%%name%%` var of `prompts/identity.md`. */
const NAME_VAR = "%%name%%"

/**
 * Fill the `%%name%%` var of the identity text. The name is user data: a
 * replacer function keeps it as is (no replace patterns), and the name is
 * not read again as a template.
 */
export function renderIdentity(name: string): string {
  return identityMd.trim().replaceAll(NAME_VAR, () => name)
}

/**
 * Read the resolved name from the fragment env. Returns `""` (the
 * "contribute nothing" signal) when unset/blank, so an unnamed session's
 * system prompt is byte-identical to one built without this plugin.
 */
export default function identityFragment(ctx: PromptFragmentContext): string {
  const raw = ctx.env?.[NAME_ENV] ?? ""
  const name = raw.trim()
  if (!name) return ""
  return renderIdentity(name)
}
