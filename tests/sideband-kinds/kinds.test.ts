// Design 40 step 3: each internal tag kind of section 3.1 has a declaration
// in the `sideband` key of its owner plugin manifest. This test boots the
// real core registry over all `ma-*` manifests (public `loadSidebandOnly`)
// and expects 0 rejected kinds, 0 bad manifest entries and 0 legacy alias
// clashes. No byte changes: the test only reads manifests.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { beforeAll, describe, expect, test } from "bun:test"

import { loadSidebandOnly, type SidebandApi } from "@minimal-agent/core/host/sideband"
import { CORE_ANNOTATION_KINDS } from "@minimal-agent/core/plugin-api"
import type { SidebandKind } from "@minimal-agent/core/plugin-api/types/sideband"

import { v1Qname } from "../../ma-sideband-plugin/lib/levels.ts"
import { makeRegistry } from "../../ma-sideband-plugin/lib/testing.ts"

const PLUGINS = resolve(import.meta.dir, "../..")
const NO_DIR = join(PLUGINS, "tmp", "sideband-kinds-no-dir")
const CORE_KINDS_CONTRACT = "sideband.kinds.core"

interface Manifest {
  id: string
  required?: boolean
  provides?: string[]
  sideband?: Omit<SidebandKind, "owner">[]
}

function manifests(): Manifest[] {
  const out: Manifest[] = []
  for (const dir of readdirSync(PLUGINS).sort()) {
    if (!dir.startsWith("ma-")) continue
    const path = join(PLUGINS, dir, "manifest.json")
    if (!existsSync(path)) continue
    out.push(JSON.parse(readFileSync(path, "utf8")) as Manifest)
  }
  return out
}

/** Design 3.1: kind, owner plugin id, v1 wire name. */
const TABLE_3_1: readonly (readonly [string, string, string])[] = [
  ["mode-active", "ma-core-tools-plugin", "ma::agent::mode-active"],
  ["mode-change", "ma-core-tools-plugin", "ma::agent::mode-change"],
  ["output-preview", "ma-core-tools-plugin", "ma::agent::output-preview"],
  ["raw-output", "ma-core-tools-plugin", "ma::agent::raw-output"],
  ["diagnostics", "ma-core-tools-plugin", "ma::agent::diagnostics"],
  ["policy", "ma-core-tools-plugin", "ma::agent::policy"],
  ["binary-result", "ma-core-tools-plugin", "ma::agent::binary-result"],
  ["redacted-asset", "ma-core-tools-plugin", "ma::agent::redacted-asset"],
  ["context-sanitizer", "ma-core-tools-plugin", "ma::agent::context-sanitizer"],
  ["turn-aborted", "turn-recovery", "ma::agent::turn-aborted"],
  ["session-resumed", "turn-recovery", "ma::agent::session-resumed"],
  ["stream-interrupted", "turn-recovery", "ma::agent::stream-interrupted"],
  ["reflection-checkpoint", "reflection-checkpoint", "ma::agent::reflection-checkpoint"],
  ["reflection-ack", "reflection-checkpoint", "ma::emit::reflection-ack"],
  ["max-tokens-continue", "turn-recovery", "ma::agent::output-truncated"],
  ["wrap-up", "turn-recovery", "ma::agent::wrap-up"],
  ["compaction", "turn-recovery", "ma::context::compaction"],
  ["behavior", "ma-base-prompt-plugin", "ma::sys::behavior"],
  ["context", "ma-base-prompt-plugin", "ma::sys::context"],
  ["emit", "ma-base-prompt-plugin", "ma::sys::emit"],
  ["mode", "ma-base-prompt-plugin", "ma::sys::mode"],
  ["tool", "ma-base-prompt-plugin", "ma::sys::tool"],
  ["memory", "memory", "ma::emit::memory"],
  ["memory-saved", "memory", "ma::agent::memory-saved"],
  ["short-term-memory", "memory", "ma::agent::short-term-memory"],
  ["tasks", "tasks", "ma::agent::tasks"],
  ["subagents", "sub-agents", "ma::agent::subagents"],
  ["budget", "sub-agents", "ma::agent::budget"],
  ["intercom-inbox", "intercom", "ma::agent::intercom-inbox"],
  ["intercom-peer", "intercom", "ma::intercom::peer"],
  ["diff", "diff-view", "ma::emit::diff"],
  ["output", "emit-output", "ma::emit::output"],
  ["interleave-thinking", "interleave-thinking", "ma::emit::interleave-thinking"],
  // Read-only kinds (no emitter today): the codec reads their old wire forms.
  ["plugins", "sideband", "ma::plugins"],
  ["tui-preview", "sideband", "ma::tui-preview"],
]

type Warning = { source: string; data: Record<string, unknown> }

/**
 * Boot the core registry over `root` and collect the sideband and manifest
 * warnings. A manifest parser warning has no `structuredData`: its code is in
 * `diagnostic.attrs` (for example `sideband_entry_invalid`).
 */
async function boot(
  root: string,
  enabled: Set<string>,
): Promise<{ api: SidebandApi; warnings: Warning[] }> {
  const warnings: Warning[] = []
  const api = await loadSidebandOnly({
    roots: { embedded: [root], user: [NO_DIR], project: [NO_DIR] },
    enabledPluginIds: enabled,
    diagnostics: {
      sessionId: undefined,
      emit: (e) => {
        const ev = e as {
          source?: string
          structuredData?: Record<string, unknown>
          diagnostic?: { attrs?: Record<string, unknown> }
        }
        const src = ev.source ?? ""
        if (src.startsWith("sideband.") || src.includes("manifest")) {
          warnings.push({ source: src, data: ev.structuredData ?? ev.diagnostic?.attrs ?? {} })
        }
      },
      emergency: () => {},
      alert: () => {},
      critical: () => {},
      error: () => {},
      warn: (source, _m, data) => {
        warnings.push({ source, data: (data ?? {}) as Record<string, unknown> })
      },
      notice: () => {},
      info: () => {},
      debug: () => {},
    },
  })
  return { api, warnings }
}

/** The warnings of a rejected kind or of a manifest entry the parser dropped. */
function rejectedOf(warnings: Warning[]): Warning[] {
  return warnings.filter(
    (w) =>
      w.source === "sideband.kind-rejected" || JSON.stringify(w.data).includes("sideband_entry"),
  )
}

describe("sideband kinds of the plugin manifests (design 40 step 3)", () => {
  const all = manifests()
  let warnings: Warning[] = []
  let api: SidebandApi

  beforeAll(async () => {
    // A plugin that is off by default still declares its kinds.
    ;({ api, warnings } = await boot(PLUGINS, new Set(all.map((m) => m.id))))
  })

  test("the core registry rejects 0 kinds and the parser drops 0 entries", () => {
    expect(rejectedOf(warnings)).toEqual([])
  })

  test("the check of test 1 sees a parser-dropped entry (bad direction)", async () => {
    const root = mkdtempSync(join(tmpdir(), "sideband-kinds-"))
    try {
      const good = all.find((m) => m.id === "ma-core-tools-plugin")?.sideband?.[0]
      expect(good).toBeDefined()
      mkdirSync(join(root, "ma-bad-plugin"))
      writeFileSync(
        join(root, "ma-bad-plugin", "manifest.json"),
        JSON.stringify({
          id: "ma-bad-plugin",
          name: "Bad",
          version: "0.0.0",
          description: "temp plugin with a bad sideband entry",
          sideband: [{ ...good, kind: "zz-bad", legacy: [], direction: "sideways" }],
        }),
      )
      const r = await boot(root, new Set(["ma-bad-plugin"]))
      expect(rejectedOf(r.warnings).map((w) => [w.data.code, w.data.field])).toEqual([
        ["sideband_entry_invalid", "direction"],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("each manifest kind is registered with its plugin as owner", () => {
    const declared = all.flatMap((m) => (m.sideband ?? []).map((k) => [k.kind, m.id] as const))
    const got = api
      .kinds()
      .map((k) => [k.kind, k.owner] as const)
      .sort()
    expect(got).toEqual([...declared].sort())
  })

  test("each kind of design table 3.1 has its owner and v1 wire name", () => {
    const view = makeRegistry([...api.kinds()])
    for (const [kind, owner, wire] of TABLE_3_1) {
      const decl = view.kind(kind)
      expect({ kind, owner: decl?.owner }).toEqual({ kind, owner })
      if (decl) expect({ kind, wire: v1Qname(decl) }).toEqual({ kind, wire })
    }
  })

  test("only a required plugin with sideband.kinds.core declares a core annotation kind", () => {
    const owners = all
      .filter((m) => m.required === true && (m.provides ?? []).includes(CORE_KINDS_CONTRACT))
      .map((m) => m.id)
    expect(owners).toEqual(["ma-core-tools-plugin"])
    const core = new Set<string>(CORE_ANNOTATION_KINDS)
    for (const m of all) {
      for (const k of m.sideband ?? []) {
        if (core.has(k.kind))
          expect({ kind: k.kind, owner: m.id }).toEqual({
            kind: k.kind,
            owner: "ma-core-tools-plugin",
          })
      }
    }
  })

  test("no two kinds hold the same name or legacy alias", () => {
    const names = new Map<string, string>()
    const clashes: string[] = []
    for (const m of all) {
      for (const k of m.sideband ?? []) {
        for (const n of [
          `kind:${k.kind}`,
          ...(k.legacy ?? []).map((a) => `alias:${a.toLowerCase()}`),
        ]) {
          const had = names.get(n)
          if (had !== undefined) clashes.push(`${n} (${had}, ${m.id})`)
          names.set(n, m.id)
        }
      }
    }
    expect(clashes).toEqual([])
  })

  test("the read-only kinds plugins and tui-preview are to-model harness kinds", () => {
    for (const name of ["plugins", "tui-preview"]) {
      const k = api.kinds().find((x) => x.kind === name)
      expect({ name, direction: k?.direction, trust: k?.trust, owner: k?.owner }).toEqual({
        name,
        direction: "to-model",
        trust: "harness",
        owner: "sideband",
      })
    }
  })

  test("attribute names use `-`: chars_removed is declared as chars-removed", () => {
    for (const k of api.kinds()) {
      for (const a of Object.keys(k.attrs))
        expect({ kind: k.kind, a }).not.toEqual({
          kind: k.kind,
          a: expect.stringContaining("_"),
        })
    }
    expect(
      Object.keys(api.kinds().find((k) => k.kind === "redacted-asset")?.attrs ?? {}),
    ).toContain("chars-removed")
  })
})
