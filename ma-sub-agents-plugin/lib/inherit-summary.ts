/**
 * Pure helpers for the lead startup profile a worker inherits (SPEC R11, R12,
 * 6.4): the R11 switch, the provider-change derivation, and the short
 * `inherit: ...` summary shown on the record and in AgentStatus.
 *
 * Only ids and short codes live here. Prose stays in prompt templates.
 *
 * @module sub-agents/lib/inherit-summary
 */

import type {
  StartupProfile,
  StartupProfilePartName,
  StartupProfileSystemPrompt,
  StartupProfileTools,
} from "./host-types.ts"

/** Env switch: `"0"` turns off profile inheritance (SPEC R11). R6/R7 still apply. */
export const ENV_SUBAGENT_INHERIT = "MINIMAL_AGENT_SUBAGENT_INHERIT"

/** True unless the env switch is exactly `"0"` (SPEC R11). */
export function inheritEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[ENV_SUBAGENT_INHERIT] !== "0"
}

/** Short code for each system-prompt part, in display order. */
const PART_CODES: readonly (readonly [StartupProfilePartName, string])[] = [
  ["full", "full"],
  ["identity", "id"],
  ["providerPreamble", "pre"],
  ["instructions", "instr"],
  ["toolOutputConventions", "toolconv"],
  ["sessionContext", "ctx"],
]

/** Parts tied to one provider. SPEC 6.4 drops them when the worker provider differs. */
const PROVIDER_PARTS: readonly StartupProfilePartName[] = ["providerPreamble"]

/** True when the profile carries a provider-specific setting (SPEC 6.4). */
export function hasProviderSpecificParts(profile: StartupProfile): boolean {
  const sp = profile.systemPrompt
  if (sp.unsafeProviderOverrides === true) return true
  return PROVIDER_PARTS.some((p) => sp[p] !== undefined && sp[p]?.kind !== "default")
}

/**
 * A copy of `profile` without the provider-specific parts (SPEC 6.4):
 * `providerPreamble` and `unsafeProviderOverrides` are removed. Pure.
 */
export function stripProviderSpecific(profile: StartupProfile): StartupProfile {
  const next: Record<string, unknown> = { ...profile.systemPrompt }
  for (const p of PROVIDER_PARTS) delete next[p]
  delete next.unsafeProviderOverrides
  return { ...profile, systemPrompt: next as StartupProfileSystemPrompt }
}

/**
 * True when SPEC 6.4 applies: both providers are known, they differ, and the
 * profile has a provider-specific part. Unknown provider: no change.
 */
export function needsProviderDerive(
  profile: StartupProfile,
  leadProvider: string | undefined,
  workerProvider: string | undefined,
): boolean {
  const lead = leadProvider?.trim()
  const worker = workerProvider?.trim()
  if (!lead || !worker || lead === worker) return false
  return hasProviderSpecificParts(profile)
}

/** How the profile reached the worker. */
export type ProfileState =
  /** `--startup-profile` was passed. */
  | "on"
  /** R11 switch set to `"0"`. */
  | "off"
  /** The host exposes no profile (older core, SPEC T8). */
  | "absent"

/** Input of {@link inheritSummary}. */
export interface InheritSummaryInput {
  readonly state: ProfileState
  /** The profile the worker gets (already derived for SPEC 6.4). Used when `state` is `"on"`. */
  readonly profile?: StartupProfile
  /** The lead tool policy the clamp used, if any. */
  readonly leadTools?: StartupProfileTools
  /** The worker's final `--mode`. */
  readonly mode: string
}

function sysPart(sp: StartupProfileSystemPrompt): string | undefined {
  const bits: string[] = []
  for (const [name, code] of PART_CODES) {
    const part = sp[name]
    if (part?.kind === "omit") bits.push(`-${code}`)
    else if (part?.kind === "replace") bits.push(`~${code}`)
  }
  if (sp.unsafeProviderOverrides === true) bits.push("!unsafe")
  return bits.length > 0 ? `sys(${bits.join(",")})` : undefined
}

function pluginPromptsPart(pp: StartupProfile["pluginPrompts"]): string | undefined {
  if (pp.all) {
    return pp.keep.length > 0 ? `plugin-prompts:off(+${pp.keep.join(",+")})` : "plugin-prompts:off"
  }
  if (pp.suppress.length > 0) return `plugin-prompts:-${pp.suppress.join(",-")}`
  return undefined
}

function pluginsPart(p: StartupProfile["plugins"]): string | undefined {
  const bits = [...p.disable.map((id) => `-${id}`), ...p.enable.map((id) => `+${id}`)]
  return bits.length > 0 ? `plugins(${bits.join(",")})` : undefined
}

function toolsPart(lead: StartupProfileTools | undefined): string {
  if (lead?.kind === "none") return "tools:none"
  if (lead?.kind === "list") return "tools:lead"
  return "tools:all"
}

/**
 * The SPEC R12 short form, e.g.
 * `inherit: sys(-instr,-toolconv) agents-md:off plugin-prompts:off tools:lead mode:ask`.
 * Pure.
 */
export function inheritSummary(input: InheritSummaryInput): string {
  const parts: string[] = []
  if (input.state === "on" && input.profile) {
    const p = input.profile
    const sys = sysPart(p.systemPrompt)
    if (sys) parts.push(sys)
    if (p.noAgentsMd) parts.push("agents-md:off")
    const pp = pluginPromptsPart(p.pluginPrompts)
    if (pp) parts.push(pp)
    const pl = pluginsPart(p.plugins)
    if (pl) parts.push(pl)
    if (p.bare) parts.push("bare")
  } else {
    parts.push(input.state === "off" ? "profile:off" : "profile:none")
  }
  parts.push(toolsPart(input.leadTools))
  parts.push(`mode:${input.mode}`)
  return `inherit: ${parts.join(" ")}`
}
