/**
 * Test helpers: sideband APIs with the core display members.
 *
 * 1. {@link realDisplaySideband}: the real core API with the real display
 *    handlers (the `ma-paste-plugin` handler reads the paste file through its
 *    own `sessions:files` host). It boots the registry over all `ma-*`
 *    manifests, as `tests/support/sideband.ts` does, with `display` set.
 * 2. {@link fakeDisplay}: the real codec, with a `display` member that gives
 *    the display results of a test. It records each call.
 *
 * Tests only. The folder `__fixtures__` is not part of the plugin runtime.
 *
 * @module __fixtures__/display-sideband
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { loadSidebandOnly, type SidebandApi } from "@minimal-agent/core/host/sideband"
import type { SidebandDisplay, SidebandNode } from "@minimal-agent/core/plugin-api/types/sideband"

const PLUGINS = resolve(import.meta.dir, "../..")
const NO_DIR = join(PLUGINS, "tmp", "sideband-fixture-no-dir")

/** The ids of all `ma-*` plugins. */
function pluginIds(): Set<string> {
  const ids = new Set<string>()
  for (const dir of readdirSync(PLUGINS)) {
    const path = join(PLUGINS, dir, "manifest.json")
    if (!dir.startsWith("ma-") || !existsSync(path)) continue
    ids.add((JSON.parse(readFileSync(path, "utf8")) as { id: string }).id)
  }
  return ids
}

const noop = (): void => {}

/**
 * The real sideband API with the display handlers. The handler hosts read the
 * session files under `sessionsDir`.
 *
 * @param sessionsDir - The sessions dir of the handler hosts.
 */
export function realDisplaySideband(sessionsDir: string): Promise<SidebandApi> {
  return loadSidebandOnly({
    roots: { embedded: [PLUGINS], user: [NO_DIR], project: [NO_DIR] },
    enabledPluginIds: pluginIds(),
    display: { hostOptions: { sessionsDir } },
    diagnostics: {
      sessionId: undefined,
      emit: noop,
      emergency: noop,
      alert: noop,
      critical: noop,
      error: noop,
      warn: noop,
      notice: noop,
      info: noop,
      debug: noop,
    },
  })
}

/**
 * Write a paste file the same way as the paste plugin, and the session file
 * that `sessions:files` needs.
 *
 * @param sessionsDir - The sessions dir.
 * @param sid - The session id.
 * @param id - The paste id.
 * @param text - The paste text.
 */
export function writePaste(sessionsDir: string, sid: string, id: string, text: string): void {
  const dir = join(sessionsDir, `${sid}.files`, "paste")
  mkdirSync(dir, { recursive: true })
  const session = join(sessionsDir, `${sid}.jsonl`)
  if (!existsSync(session)) writeFileSync(session, "")
  writeFileSync(join(dir, `${id}.txt`), text)
}

/** One recorded `display` call of {@link fakeDisplay}. */
export interface DisplayCall {
  text: string
  opts: Parameters<SidebandApi["display"]>[1]
}

/**
 * The real codec with a fake `display`: each paste node gets the result of
 * `result` (undefined: no display, as for a failed handler). Each other kind
 * gets a label, as a real handler of another plugin does.
 *
 * @param sb - The real API (`tests/support/sideband.ts`).
 * @param result - The display of one paste node.
 */
export function fakeDisplay(
  sb: SidebandApi,
  result: (node: SidebandNode) => SidebandDisplay | undefined,
): SidebandApi & { calls: DisplayCall[] } {
  const calls: DisplayCall[] = []
  const display: SidebandApi["display"] = (text, opts) => {
    calls.push({ text, opts })
    const segments: ReturnType<SidebandApi["display"]>["segments"] = []
    let at = 0
    for (const node of sb.find(text, opts.kinds ? { kinds: opts.kinds } : {})) {
      if (node.span.start < at) continue
      const d = node.kind === "paste" ? result(node) : { label: `label of ${node.kind}` }
      if (d === undefined) continue
      if (node.span.start > at)
        segments.push({ type: "text", text: text.slice(at, node.span.start) })
      segments.push({ type: "node", node, kind: node.kind, display: d, cp: node.span })
      at = node.span.end
    }
    if (segments.length === 0) return { segments: [{ type: "text", text }], changed: false }
    if (at < text.length) segments.push({ type: "text", text: text.slice(at) })
    return { segments, changed: true }
  }
  const view = Object.defineProperties({}, Object.getOwnPropertyDescriptors(sb)) as SidebandApi
  return Object.assign(view, { display, calls })
}

/**
 * The real codec with no display members, as an old host gives it.
 *
 * @param sb - The real API.
 */
export function noDisplay(sb: SidebandApi): Omit<SidebandApi, "display" | "displayNode"> {
  const view = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(sb),
  ) as Partial<SidebandApi>
  delete view.display
  delete view.displayNode
  return view as Omit<SidebandApi, "display" | "displayNode">
}
