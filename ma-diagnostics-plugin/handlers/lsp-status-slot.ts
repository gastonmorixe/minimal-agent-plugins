/**
 * Live-area slot handler for the diagnostics plugin.
 *
 * Periodically updates the decoration suffix with a compact line showing
 * which persistent LSP providers are currently active (booted and alive).
 * The suffix is appended to the first header decoration row by the
 * LiveAreaScheduler so it shares the intercom roster line.
 *
 * Phase 3 multi-root: collapses same-id servers to `tsc×2` or shows short
 * basenames (`tsc:core · tsc:plugins`) when width allows.
 *
 * Returns null (no slot content) — the visual is handled by the suffix.
 *
 * @module plugins/diagnostics/handlers/lsp-status-slot
 */

import { basename } from "node:path"

import { ansiStyle as c } from "../lib/ansi.ts"
import type { LiveAreaHandlerContext } from "../lib/host-types.ts"
import type { ActivePersistentProvider } from "../lib/service.ts"

import { getActivePersistentProvidersDetailed } from "./on_tool_did_invoke.ts"

/**
 * Icons for known persistent providers. Falls back to "⚙" for unknown ids.
 */
const ICONS: Record<string, string> = {
  tsgo: "\u00b7", // · (TypeScript, native-preview)
  tsc: "\u00b7", // · (TypeScript 7+ native tsc --lsp)
  "sourcekit-lsp": "\u267b", // ♻ (Swift/Obj-C)
}

const ICON_FALLBACK = "\u2699" // ⚙

const MAX_FOOTER_PARTS = 3

function toolLabel(id: string): string {
  return id === "sourcekit-lsp" ? "sk-lsp" : id
}

/**
 * Compact footer fragments from active providers.
 * - one root: `· tsc`
 * - multi root same id: `· tsc×2` (or basenames if ≤2 and short)
 * - mixed tools: join with middots, cap + overflow
 */
export function formatLspFooterParts(active: ActivePersistentProvider[]): string[] {
  if (active.length === 0) return []

  // Group by id preserving order of first appearance.
  const byId = new Map<string, ActivePersistentProvider[]>()
  for (const p of active) {
    const list = byId.get(p.id) ?? []
    list.push(p)
    byId.set(p.id, list)
  }

  const parts: string[] = []
  for (const [id, list] of byId) {
    const icon = ICONS[id] ?? ICON_FALLBACK
    const label = toolLabel(id)
    if (list.length === 1) {
      parts.push(`${icon} ${label}`)
      continue
    }
    // Prefer compact count; use basenames when only two roots and names are short.
    if (list.length === 2) {
      const a = basename(list[0].root)
      const b = basename(list[1].root)
      if (a.length + b.length <= 24 && a && b && a !== b) {
        parts.push(`${icon} ${label}:${a}`)
        parts.push(`${icon} ${label}:${b}`)
        continue
      }
    }
    parts.push(`${icon} ${label}\u00d7${list.length}`)
  }

  if (parts.length <= MAX_FOOTER_PARTS) return parts
  const head = parts.slice(0, MAX_FOOTER_PARTS)
  head.push(`+${parts.length - MAX_FOOTER_PARTS}`)
  return head
}

/**
 * Poll active LSP providers every 3s and update the decoration suffix.
 * Returns null so no separate header line is rendered — the suffix rides
 * on the first decoration row (intercom roster line).
 */
export default async function lspStatusSlot(ctx: LiveAreaHandlerContext): Promise<string | null> {
  const active = getActivePersistentProvidersDetailed()
  if (active.length === 0) {
    ctx.setDecorationSuffix?.("")
    return null
  }

  const parts = formatLspFooterParts(active).map((p) => c.dim(p))
  ctx.setDecorationSuffix?.(` ${parts.join(c.dim(" \u00b7 "))}`)
  return null
}
