/**
 * Boot error renderer. User text for `ContractCheckFailedError`: the boot
 * refused to start because a required contract has no provider plugin, or
 * two providers in the same plugin tier. The text names every contract.
 *
 * @module ma-host-text-plugin/boot-error-renderer
 */

import { type CoreErrorJson, type ErrorRenderer, isCoreErrorJson } from "@minimal-agent/core/errors"

/** The kind this renderer covers. */
export const CONTRACT_CHECK_FAILED_KIND = "ContractCheckFailedError"

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

/** Text of one `ContractCheckFailedError` JSON. */
export function contractCheckFailedText(err: CoreErrorJson): string {
  const missing = ids(err.fields.missing)
  const duplicates = ids(err.fields.duplicates)
  const lines = ["boot refused: required plugin contracts are not met."]
  if (missing.length > 0) {
    lines.push(`missing (no plugin provides them): ${missing.join(", ")}`)
  }
  if (duplicates.length > 0) {
    lines.push(`duplicated (two plugins in the same tier): ${duplicates.join(", ")}`)
  }
  lines.push(
    "Install or enable the plugins that provide them (for example ma-base-prompt-plugin, " +
      "ma-core-tools-plugin, ma-turn-recovery-plugin, ma-prompt-template-plugin).",
  )
  return lines.join("\n")
}

/** Create the boot error renderer. It declines every other kind. */
export function createBootErrorRenderer(): ErrorRenderer {
  return {
    kinds: [CONTRACT_CHECK_FAILED_KIND],
    render(err: CoreErrorJson): string | undefined {
      if (!isCoreErrorJson(err) || err.kind !== CONTRACT_CHECK_FAILED_KIND) return undefined
      return contractCheckFailedText(err)
    },
  }
}
