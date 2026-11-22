/**
 * Terminal setup of the paste plugin (PLAN 4.4). It registers the text
 * paste hook (priority 50) and the `paste` chip label. Both need CLI
 * support (`ctx.paste`, `ctx.chips`). When the CLI does not give them,
 * setup does nothing.
 *
 * The text hook saves the paste at once to a session file and gives back a
 * self-closing ref. The plugin keeps no paste text in RAM.
 *
 * @module ui/setup
 */

import { type CollapseConfig, loadPasteConfig, shouldCollapse } from "../lib/config.ts"
import { countLines, normalizeNewlines, utf8Bytes } from "../lib/count.ts"
import { chipLabel } from "../lib/format.ts"
import type { PasteUiContext, PluginPasteEvent, PluginPasteHook } from "../lib/host-types.ts"
import { newId } from "../lib/id.ts"

/** The sideband kind of a paste ref. */
const PASTE_KIND = "paste"

/** The priority of the text hook. The media hook is 90. */
export const TEXT_HOOK_PRIORITY = 50

/** The number of creates before the hook gives up on `"exists"`. */
export const MAX_CREATE_TRIES = 8

/** Options of {@link makeTextPasteHook} (tests). */
export interface TextPasteHookOptions {
  collapse?: CollapseConfig
  newId?: () => string
  warn?: (code: string, message: string) => void
}

/**
 * The text paste hook. It returns null (the paste goes in as literal text)
 * when there is no codec, no file store, a blank paste, a paste below the
 * collapse threshold, or a failed create. After a failed create it sends
 * one warning for each failure kind in each process.
 */
export function makeTextPasteHook(opts: TextPasteHookOptions = {}): PluginPasteHook {
  const collapse = opts.collapse ?? loadPasteConfig().collapse
  const makeId = opts.newId ?? (() => newId())
  const warned = new Set<string>()
  const warnOnce = (code: string, message: string): void => {
    if (warned.has(code)) return
    warned.add(code)
    try {
      opts.warn?.(code, message)
    } catch {
      // A logger must not stop the paste.
    }
  }
  return {
    id: "paste.text",
    priority: TEXT_HOOK_PRIORITY,
    onPaste(ev: PluginPasteEvent) {
      const sb = ev.sideband
      const files = ev.files
      if (!sb?.ready || !files) return null
      if (ev.text.trim() === "") return null
      const text = normalizeNewlines(ev.text)
      const bytes = utf8Bytes(text)
      const lines = countLines(text)
      if (!shouldCollapse(collapse, lines, bytes)) return null
      for (let i = 0; i < MAX_CREATE_TRIES; i++) {
        const id = makeId()
        const r = files.create(`${id}.txt`, text)
        if (r === "ok") return { insert: sb.render(PASTE_KIND, { attrs: { id, bytes, lines } }) }
        if (r !== "exists") {
          warnOnce(`paste.${r}`, `paste file not saved (${r}); the paste goes in as text`)
          return null
        }
      }
      warnOnce("paste.exists", "no free paste id; the paste goes in as text")
      return null
    },
  }
}

/** Register the text paste hook and the chip label. No CLI support: no-op. */
export default function setup(ctx: PasteUiContext): void {
  if (ctx.paste) {
    const warn = (code: string, message: string): void => ctx.log?.warn(code, message)
    ctx.paste.registerHook(makeTextPasteHook({ warn }))
  }
  ctx.chips?.register({ kind: PASTE_KIND, label: chipLabel })
}
