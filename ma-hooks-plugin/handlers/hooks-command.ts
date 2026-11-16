/**
 * The `/hooks` slash command (SPEC.md user stories 54 and 55).
 *
 * 1. `/hooks` or `/hooks list`: every parsed hook, grouped by channel.
 * 2. `/hooks trust <key>`, `/hooks untrust <key>`.
 * 3. `/hooks enable <key>`, `/hooks disable <key>`.
 * 4. `/hooks trust-all <file>`: trust every hook of one source file.
 *
 * Writes go through `engine/trust.ts` (atomic). The state file is in the
 * engine reload signature (`engine/engine.ts` `watched`), so every engine sees
 * the change at its next dispatch. Command contract: core
 * `plugin-api/src/types/plugin.ts:1364-1388` (CommandResult) and `:1393-1441`
 * (CommandContext). A bad key or file returns `{ kind: "error" }`, never a throw.
 *
 * @module handlers/hooks-command
 */

import type { CommandContext, CommandResult } from "@minimal-agent/core/plugin-api/types/plugin"

import type { HookStatus, HooksEngine } from "../engine/engine.ts"
import { handlerPreview } from "../engine/notice.ts"

import { engineFor } from "./dispatch.ts"

/** The usage line. */
export const HOOKS_USAGE =
  "usage: /hooks [list] | trust <key> | untrust <key> | enable <key> | disable <key> | trust-all <file>"

/** Support state text of one hook. */
function supportText(s: HookStatus): string {
  return s.hook.support === "ok" ? "supported" : s.hook.support
}

/** The last result: `last: deny at <ISO time>`, or `last: never`. */
function lastText(s: HookStatus): string {
  if (!s.last) return "last: never"
  return `last: ${s.last.outcome} at ${new Date(s.last.at).toISOString()}`
}

/** Max hooks that `/hooks list` shows. The rest is one `... N more` line. */
export const LIST_MAX_HOOKS = 200

/** The rows of `/hooks list`, grouped by channel (unsupported events last). */
export function listLines(eng: HooksEngine, max = LIST_MAX_HOOKS): string[] {
  const rows = eng.status()
  if (rows.length === 0) return ["No hooks configured."]
  const groups = new Map<string, HookStatus[]>()
  for (const r of rows) {
    const ch = r.hook.channel || `(unsupported event ${r.hook.dialectEvent})`
    const g = groups.get(ch) ?? []
    g.push(r)
    groups.set(ch, g)
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const ua = a.startsWith("(") ? 1 : 0
    const ub = b.startsWith("(") ? 1 : 0
    return ua - ub || (a < b ? -1 : a > b ? 1 : 0)
  })
  const out: string[] = []
  let shown = 0
  for (const ch of keys) {
    if (shown >= max) break
    out.push(`${ch}:`)
    for (const r of groups.get(ch) ?? []) {
      if (shown >= max) break
      shown++
      const h = r.hook
      const match = [
        `matcher ${h.matcher === undefined || h.matcher === "" ? "*" : h.matcher}`,
        ...(h.filter !== undefined ? [`if ${h.filter}`] : []),
        // `after` is the default, so only `before` is shown.
        ...(h.position === "before" ? ["position before"] : []),
      ].join(", ")
      out.push(`  ${h.trustKey}`)
      out.push(`    ${h.dialect} ${h.dialectEvent}, ${match}: ${handlerPreview(h)}`)
      out.push(`    ${h.source.path} (${h.source.scope})`)
      out.push(`    ${r.trust}, ${r.enabled}, ${supportText(r)}, ${lastText(r)}`)
    }
  }
  if (rows.length > shown) out.push(`... ${rows.length - shown} more`)
  return out
}

/**
 * `trust` and `trust-all` also mark the project trusted (`engine/trust.ts`
 * `trustHook`, `trustHooks`), which turns on its disable switches. Say so
 * (review B3 MINOR 4).
 */
export function projectTrustedLine(root: string): string {
  return `project ${root} is now trusted; its disable switches apply`
}

function notice(info: string, body: string[]): CommandResult {
  return { kind: "notice", block: { icon: "#", title: "hooks", info, body } }
}

function err(message: string): CommandResult {
  return { kind: "error", message: `hooks: ${message}` }
}

/** Run one `/hooks` sub-command on an engine. Never throws. */
export function runHooksCommand(eng: HooksEngine, argv: string): CommandResult {
  const [sub = "list", ...rest] = argv.trim().split(/\s+/).filter(Boolean)
  const arg = rest.join(" ")
  const root = eng.projectRoot
  try {
    if (sub === "list") {
      if (arg) return err(HOOKS_USAGE)
      return notice(`${eng.all.length} hook(s), project ${root}`, listLines(eng))
    }
    if (sub === "trust-all") {
      if (!arg) return err(`trust-all needs a file. ${HOOKS_USAGE}`)
      const hooks = eng.hooksFromFile(arg)
      if (hooks.length === 0) return err(`no hooks from file ${arg} (see /hooks list)`)
      eng.trust.trustHooks(root, hooks)
      eng.reloadIfChanged()
      return notice(`trusted ${hooks.length} hook(s)`, [
        ...hooks.map((h) => h.trustKey),
        projectTrustedLine(root),
      ])
    }
    if (!["trust", "untrust", "enable", "disable"].includes(sub)) return err(HOOKS_USAGE)
    if (!arg || rest.length !== 1) return err(`${sub} needs one trust key. ${HOOKS_USAGE}`)
    const hook = eng.findHook(arg)
    if (!hook) return err(`unknown trust key ${arg} (see /hooks list)`)
    if (sub === "trust") eng.trust.trustHook(root, hook)
    else if (sub === "untrust") eng.trust.untrustHook(root, hook)
    else eng.trust.setEnabled(root, hook.trustKey, sub === "enable")
    eng.reloadIfChanged()
    const extra =
      hook.source.scope === "user" && (sub === "trust" || sub === "untrust")
        ? ["Note: user-scope hooks are trusted implicitly, so trust state does not gate them."]
        : []
    if (sub === "trust") extra.push(projectTrustedLine(root))
    return notice(`${sub} ${hook.trustKey}`, [`done: ${sub} ${hook.trustKey}`, ...extra])
  } catch (e) {
    return err(`${sub} failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Default export: the `/hooks` command handler. */
export default function hooksCommand(ctx: CommandContext): CommandResult {
  try {
    return runHooksCommand(engineFor(ctx.cwd), ctx.argv ?? "")
  } catch (e) {
    return err(`internal error: ${e instanceof Error ? e.message : String(e)}`)
  }
}
