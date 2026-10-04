/**
 * Route skill-discovery diagnostics through the host diagnostic bus.
 *
 * Plugins must not paint TUI chrome for load failures or catalog overflow.
 * Call `log.warn` so core can file-log the event and fill the last-warn slot.
 *
 * @module lib/report-broken
 */

import type { BrokenSkill, PluginLogger, Skill } from "./types.ts"

/** RFC 5424 MSGID suffix. Host prefixes with the plugin id. */
export const BROKEN_SKILL_LOG_SOURCE = "skill-load"

/** Prompt-catalog overflow (maxSkills). Host prefixes with the plugin id. */
export const CATALOG_CAP_LOG_SOURCE = "skill-catalog"

/**
 * Emit one warning per broken skill. Failures from `log.warn` are
 * swallowed so a logging glitch cannot abort session boot.
 */
export function warnBrokenSkills(log: PluginLogger, broken: readonly BrokenSkill[]): void {
  for (const b of broken) {
    const first = b.errors[0] ?? "unknown error"
    const more = b.errors.length > 1 ? ` (+${b.errors.length - 1} more)` : ""
    try {
      log.warn(BROKEN_SKILL_LOG_SOURCE, `skill "${b.dirName}" not loaded: ${first}${more}`, {
        name: b.dirName,
        dir: b.dir,
        scope: b.scope,
        reason: first,
        errorCount: b.errors.length,
      })
    } catch {
      // Logging itself must never break boot.
    }
  }
}

const OMITTED_NAME_SAMPLE = 8

/**
 * Emit one warning when `maxSkills` hid packs from the Level-1 prompt
 * catalog. The Skill tool still sees the omitted names.
 */
export function warnSkillCatalogCap(
  log: PluginLogger,
  omitted: readonly Skill[],
  maxSkills: number,
): void {
  if (omitted.length === 0) return
  const names = omitted.map((s) => s.front.name)
  const sample = names.slice(0, OMITTED_NAME_SAMPLE).join(", ")
  const extra =
    names.length > OMITTED_NAME_SAMPLE ? ` (+${names.length - OMITTED_NAME_SAMPLE} more)` : ""
  try {
    log.warn(
      CATALOG_CAP_LOG_SOURCE,
      `skill catalog capped at ${maxSkills}: omitted ${omitted.length} (${sample}${extra}). Skill list/info/read still resolve them.`,
      {
        maxSkills,
        omittedCount: omitted.length,
        omitted: names.join(","),
      },
    )
  } catch {
    // Logging itself must never break boot.
  }
}
