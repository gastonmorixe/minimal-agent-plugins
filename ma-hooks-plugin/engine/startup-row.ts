/**
 * The `hooks` row of the CLI startup header (design H1 section 3).
 *
 * A pure builder: `/hooks` status rows in, one {@link StartupRow} out. The
 * trust and enabled rules stay in `engine/engine.ts` (`HooksEngine.status`)
 * and `engine/trust.ts`. This file only maps those states onto counts and
 * tones.
 *
 * Counting rules:
 * 1. Unsupported hooks (`unsupported-type`, `unsupported-event`) and
 *    `shadowed` duplicates never run and are left out (no count, no child).
 * 2. `disabled` = enabled state `disabled` (state file) or
 *    `disabled-by-config` (a disable switch). It wins over trust.
 * 3. `untrusted` = enabled, but trust is `untrusted` or `untrusted-hash`.
 * 4. `active` = enabled and trusted (`trusted`, `implicit-user`, `env`).
 *
 * @module engine/startup-row
 */

import { basename } from "node:path"

import type { HookStatus } from "./engine.ts"
import type { CanonicalHook } from "./types.ts"

// mirror of plugin-api StartupRow/Part; switch to the import when core lands

/** One styled text part. Plugins send semantic tones, never ANSI. */
export type Part = { text: string; tone?: "default" | "dim" | "accent" | "warn" | "ok" }

/** One startup header row, with an optional sub-tree. */
export type StartupRow = {
  label: string
  summary: Part[]
  children?: { label: string; value: Part[] }[]
  order?: number
}

/** The `startup.rows` chain payload. */
export type StartupRowsPayload = { cwd: string; cols: number; rows: StartupRow[] }

/** Row label. No `order`: the CLI keeps the chain order. */
export const HOOKS_ROW_LABEL = "hooks"

/**
 * Child order: the channels in lifecycle order (session, turn, tools, stop,
 * end). Not the `HOOK_CHANNELS` key order, which puts `turn.willStop` before
 * `tool.willInvoke` and so breaks the design sample. Unknown channels go last.
 */
export const CHILD_CHANNEL_ORDER: readonly string[] = [
  "session.willStart",
  "instructions.didLoad",
  "cwd.didChange",
  "turn.willStart",
  "subagent.willSpawn",
  "tool.willInvoke",
  "tool.didInvoke",
  "tool.didBatch",
  "compact.willRun",
  "compact.didRun",
  "turn.willStop",
  "notification.emit",
  "agent.willStop",
]

/** Programs whose first plain argument is the real script. */
const INTERPRETERS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "python",
  "python3",
  "node",
  "bun",
])

/** `NAME=value` at the start of a shell command. */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Split a shell command into words. Quotes group and are removed. */
function words(command: string): string[] {
  const out: string[] = []
  for (const m of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const w = m[1] ?? m[2] ?? m[3] ?? ""
    out.push(w.replaceAll(/["']/g, ""))
  }
  return out
}

/** Last path segment, without trailing slashes. */
function lastSegment(path: string): string {
  return basename(path.replace(/\/+$/, "")) || path
}

/**
 * The display name of a command: the basename of its first word after any
 * `NAME=value` prefix. When that word is an interpreter (sh, bash, zsh,
 * python, python3, node, bun), the first argument that is not a flag is used
 * instead, else the interpreter name. Exec form (`args`) uses the command as
 * one word.
 */
export function commandBasename(command: string, args?: readonly string[]): string {
  const list = args && args.length > 0 ? [command, ...args] : words(command)
  let i = 0
  while (i < list.length - 1 && ENV_ASSIGN.test(list[i] ?? "")) i++
  const first = list[i]
  if (first === undefined || first === "") return command.trim()
  const prog = lastSegment(first)
  if (!INTERPRETERS.has(prog)) return prog
  const script = list.slice(i + 1).find((w) => w !== "" && !w.startsWith("-"))
  return script ? lastSegment(script) : prog
}

/** The host of an HTTP hook URL, or the URL text when it does not parse. */
function urlHost(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** `<matcher> → <target>`, or the target alone for no matcher or `*`. */
function targetText(h: CanonicalHook): string {
  const target =
    h.handler.type === "http"
      ? urlHost(h.handler.url)
      : commandBasename(h.handler.command, h.handler.args)
  const m = h.matcher?.trim()
  return m && m !== "*" ? `${m} → ${target}` : target
}

type Kind = "active" | "untrusted" | "disabled"

/** The row kind of one status, or `undefined` when it is left out. */
function kindOf(s: HookStatus): Kind | undefined {
  if (s.hook.support !== "ok" || s.hook.channel === "") return undefined
  if (s.enabled === "shadowed") return undefined
  if (s.enabled !== "enabled") return "disabled"
  if (s.trust === "untrusted" || s.trust === "untrusted-hash") return "untrusted"
  return "active"
}

function channelRank(channel: string): number {
  const i = CHILD_CHANNEL_ORDER.indexOf(channel)
  return i < 0 ? CHILD_CHANNEL_ORDER.length : i
}

/**
 * Build the `hooks` startup row from `/hooks` status rows (pass
 * `engine.status()`). Returns `null` when no hook is listed, so the CLI omits
 * the row. Pure: no file access, no clock.
 */
export function buildHooksStartupRow(statuses: readonly HookStatus[]): StartupRow | null {
  const listed = statuses
    .map((s, i) => ({ s, i, kind: kindOf(s) }))
    .filter((x): x is { s: HookStatus; i: number; kind: Kind } => x.kind !== undefined)
  if (listed.length === 0) return null
  listed.sort((a, b) => channelRank(a.s.hook.channel) - channelRank(b.s.hook.channel) || a.i - b.i)
  const count = (k: Kind) => listed.filter((x) => x.kind === k).length
  const untrusted = count("untrusted")
  const disabled = count("disabled")
  const summary: Part[] = [{ text: `${count("active")} active`, tone: "ok" }]
  if (untrusted > 0) summary.push({ text: `${untrusted} untrusted`, tone: "warn" })
  if (disabled > 0) summary.push({ text: `${disabled} disabled`, tone: "dim" })
  const children = listed.map(({ s, kind }) => {
    const h = s.hook
    const value: Part[] = [{ text: targetText(h), tone: "accent" }]
    if (h.dialect !== "native") value.push({ text: h.dialect })
    if (h.position === "before") value.push({ text: "before" })
    if (kind === "untrusted") value.push({ text: "untrusted", tone: "warn" })
    if (kind === "disabled") value.push({ text: "disabled", tone: "dim" })
    return { label: h.channel, value }
  })
  return { label: HOOKS_ROW_LABEL, summary, children }
}
