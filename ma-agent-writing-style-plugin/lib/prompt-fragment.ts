/**
 * No-op prompt fragment.
 *
 * Why this exists: minimal-agent's manifest validator rejects plugins that
 * don't declare at least one of `tuis` / `modes` / `events` / `hooks` /
 * `promptFragments` / `liveAreaSlots`. The top-level `prompt` field that
 * loads our PROMPT.md is NOT counted as a valid contribution by that gate,
 * even though it works fine and gets injected.
 *
 * This module is the cheapest way to satisfy the validator. The actual
 * rules live in `PROMPT.md`, injected via the top-level `prompt` field.
 * This handler returns `""` so it contributes zero tokens and zero runtime
 * cost beyond a one-time module load at session start.
 *
 * When the upstream validator accepts a `prompt`-only manifest, remove
 * this file and the matching `promptFragments` entry from `manifest.json`.
 *
 * @returns empty string (no system-prompt content)
 */
export default function maAgentWritingStylePromptFragment(): string {
  return ""
}
