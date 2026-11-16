/**
 * Pure mode clamp (SPEC R7, R8). A worker mode is never more permissive than
 * the lead's LIVE mode at spawn time. "More permissive" is computed from each
 * mode's `{allow, deny}` tool lists. When the role mode is not provably at most
 * as permissive as the lead mode, the worker gets the lead mode.
 *
 * @module sub-agents/lib/mode-clamp
 */

import type { HostPolicySnapshot, ModePolicyEntry } from "./host-types.ts"

/** The mode id that means "no mode" (unrestricted) on the CLI `--mode` flag. */
export const NO_MODE_ID = "none"

/** A synthetic tool name that no mode names. It stands for every unknown tool. */
const UNKNOWN_TOOL = "\u0000unknown-tool"

/** Result of {@link clampMode}. */
export interface ModeClamp {
  /** The mode id to pass to `--mode`, or null when the caller has no role mode. */
  readonly mode: string | null
  /** True when the clamp replaced the role mode with the lead mode (SPEC R13). */
  readonly lowered: boolean
}

type Perms = ModePolicyEntry["permissions"]

/**
 * True when a mode with `perms` allows `tool`. `null` = no mode (all allowed).
 * Order mirrors core `ModeManager` first-match rules: exact deny, exact allow,
 * exact match, wildcard deny, wildcard allow, wildcard match, else denied. A
 * "match" (predicate) rule allows some inputs only, so its answer is `matchAs`:
 * `true` judges a mode by its widest reach, `false` by its narrowest.
 */
export function allows(perms: Perms | null, tool: string, matchAs = false): boolean {
  if (perms === null) return true
  const match = perms.match ?? []
  for (const name of [tool, "*"]) {
    if (perms.deny.includes(name)) return false
    if (perms.allow.includes(name)) return true
    if (match.includes(name)) return matchAs
  }
  return false
}

/** Normalize a mode id: null, empty and {@link NO_MODE_ID} all mean "no mode". */
function modeKey(id: string | null | undefined): string | null {
  const t = id?.trim() ?? ""
  return t.length === 0 || t === NO_MODE_ID ? null : t
}

/** Every tool name the comparison must check. */
function universe(a: Perms | null, b: Perms | null, snap: HostPolicySnapshot): Set<string> {
  const names = new Set<string>([UNKNOWN_TOOL])
  for (const p of [a, b]) {
    if (!p) continue
    for (const n of p.allow) if (n !== "*") names.add(n)
    for (const n of p.deny) if (n !== "*") names.add(n)
    for (const n of p.match ?? []) if (n !== "*") names.add(n)
  }
  if (snap.tools.kind === "list") for (const n of snap.tools.names) names.add(n)
  return names
}

/**
 * True when every tool `role` allows is also allowed by `lead`. Conservative
 * on "match" rules: the role counts them as allowed, the lead as denied.
 */
function atMostAsPermissive(
  role: Perms | null,
  lead: Perms | null,
  snap: HostPolicySnapshot,
): boolean {
  for (const t of universe(role, lead, snap)) {
    if (allows(role, t, true) && !allows(lead, t, false)) return false
  }
  return true
}

/**
 * Clamp a role mode to the lead's live mode.
 *
 * 1. No snapshot (older core, SPEC T8): see {@link clampWithoutSnapshot}.
 * 2. Role mode not in `snap.modes` (and not "no mode"), or lead mode unknown:
 *    use the lead mode.
 * 3. Role mode at most as permissive as the lead mode: keep it.
 * 4. Else (wider or not comparable): use the lead mode.
 *
 * The lead mode id is `snap.activeModeId`, or {@link NO_MODE_ID} when null.
 * `envLeadMode` (the lead's `MINIMAL_AGENT_MODE`) is used only with no snapshot.
 */
export function clampMode(
  roleMode: string | null,
  snap: HostPolicySnapshot | undefined,
  envLeadMode?: string,
): ModeClamp {
  if (!snap) return clampWithoutSnapshot(roleMode, envLeadMode)
  const leadKey = modeKey(snap.activeModeId)
  const leadId = leadKey ?? NO_MODE_ID
  const roleKey = modeKey(roleMode)
  const lowerTo = (): ModeClamp => ({ mode: leadId, lowered: roleKey !== leadKey })

  if (roleKey === leadKey) return { mode: roleMode ?? leadId, lowered: false }
  const find = (id: string): ModePolicyEntry | undefined => snap.modes.find((m) => m.id === id)
  const leadEntry = leadKey === null ? undefined : find(leadKey)
  if (leadKey !== null && !leadEntry) return lowerTo()
  const roleEntry = roleKey === null ? undefined : find(roleKey)
  if (roleKey !== null && !roleEntry) return lowerTo()

  const leadPerms = leadEntry?.permissions ?? null
  const rolePerms = roleEntry?.permissions ?? null
  if (atMostAsPermissive(rolePerms, leadPerms, snap)) return { mode: roleMode, lowered: false }
  return lowerTo()
}

/**
 * Best-effort clamp with no snapshot (older core, SPEC T8). No mode
 * permissions are known, so nothing can be compared. When the lead's mode
 * (env `MINIMAL_AGENT_MODE`) names a real mode and the role mode differs, the
 * worker gets the lead mode (fail safe: a writable `none` role never escapes a
 * restricted lead). Lead env unset, empty or `none`: keep the role mode.
 */
export function clampWithoutSnapshot(roleMode: string | null, envLeadMode?: string): ModeClamp {
  const leadKey = modeKey(envLeadMode)
  if (leadKey === null || modeKey(roleMode) === leadKey) return { mode: roleMode, lowered: false }
  return { mode: leadKey, lowered: true }
}
