/**
 * Byte parity of the turn-recovery provider against the old core texts
 * (core-prompts decouple P2.2), after the P4 STE rewrite.
 *
 * One row per synthetic.json entry whose proposedKind this plugin owns. Each
 * row runs the REAL core call site (the same mapping of fixture args to a core
 * path as core's runtime-text and tool-result-text parity tables) through a
 * resolver that hands the facts core passes straight to this provider, with
 * no fallback for an owned kind. The provider output must equal the STE text
 * of the fixture (`toSte` in `__fixtures__/ste-p4.ts` maps each old text to its
 * new text) byte for byte. Core is imported here, in the test only.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type {
  SyntheticFacts,
  SyntheticKind,
} from "@minimal-agent/core/plugin-api/types/synthetic-text"

import {
  closeInterruptedToolCalls,
  repairOrphanedToolUse,
} from "../node_modules/@minimal-agent/core/src/agent/history-repair.ts"
import type { SyntheticTextResolver } from "../node_modules/@minimal-agent/core/src/agent/synthetic-text.ts"
import {
  continueText,
  placeholderText,
} from "../node_modules/@minimal-agent/core/src/agent/synthetic-texts.ts"
import type { ModalitySupport } from "../node_modules/@minimal-agent/core/src/llm/capabilities.ts"
import type { Message } from "../node_modules/@minimal-agent/core/src/llm/messages.ts"
import {
  checkMedia,
  checkMediaSet,
  type MediaLimits,
} from "../node_modules/@minimal-agent/core/src/media/limits.ts"
import type { MediaRegistry } from "../node_modules/@minimal-agent/core/src/media/registry.ts"
import { resolveMediaTurn } from "../node_modules/@minimal-agent/core/src/media/resolve.ts"
import {
  formatBytes as coreFormatBytes,
  type MediaItem,
  type MediaKind,
} from "../node_modules/@minimal-agent/core/src/media/types.ts"
import {
  invokeSubprocess,
  pluginHandlerErrorText,
  subprocessOverflowText,
  unknownPluginToolText,
} from "../node_modules/@minimal-agent/core/src/plugins/loader/helpers.ts"
import { NO_TOOLS_EXECUTOR } from "../node_modules/@minimal-agent/core/src/runtime/noop-tools.ts"
import {
  buildInitialUserContent,
  nextRoundContent,
} from "../node_modules/@minimal-agent/core/src/sdk/agent-core-helpers.ts"
import * as T from "../node_modules/@minimal-agent/core/src/tools/tool-result-text.ts"

import { RULE_HITS, RULE_NAMES, toSte } from "./__fixtures__/ste-p4.ts"
import manifest from "./manifest.json"
import { createTurnRecoveryProvider, formatBytes } from "./provider.ts"

const FIXTURE = join(import.meta.dir, "..", "tests", "text-parity", "fixtures", "synthetic.json")

interface FixtureCase {
  args: unknown[]
  text: string
}
interface FixtureEntry {
  fn: string
  file: string
  proposedKind: string
  cases: FixtureCase[]
}

const entries = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { entries: FixtureEntry[] }).entries

const provider = createTurnRecoveryProvider()
const OWNED: ReadonlySet<string> = new Set(provider.kinds)

/** The base kind of a proposedKind (`tool_result.aborted{site:orphan}`, `continue.*`). */
function baseKind(proposed: string): string {
  return proposed.split("{")[0] ?? ""
}

function owned(e: FixtureEntry): boolean {
  const k = baseKind(e.proposedKind)
  if (k.endsWith(".*")) return provider.kinds.some((x) => x.startsWith(k.slice(0, -1)))
  return OWNED.has(k)
}

const rows = entries.filter(owned)

/** Every call core made to an owned kind during one run. */
type Calls = Array<{ kind: SyntheticKind; facts: SyntheticFacts }>

/**
 * A resolver that passes core's facts straight to the provider (a provider
 * throw fails the test). Another kind (none expected on these paths) gets
 * "", as in core, which has no fallback text.
 */
function live(calls: Calls): SyntheticTextResolver {
  return {
    resolve(kind, facts) {
      if (!OWNED.has(kind)) return ""
      calls.push({ kind, facts })
      const out = provider.text(kind, facts)
      expect(out.length).toBeGreaterThan(0)
      return out
    },
  }
}

const s = (v: unknown): string => v as string
const n = (v: unknown): number => v as number
type Obj = Record<string, unknown>

function firstText(blocks: Array<{ type: string; text?: string }>): string {
  return blocks.find((b) => b.type === "text")?.text ?? ""
}

function orphanHistory(): Message[] {
  return [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
  ]
}

const NO_MODALITY: ModalitySupport = { image: false, pdf: false, audio: false, video: false }
const ALL_MODALITY: ModalitySupport = { image: true, pdf: true, audio: true, video: true }

function limits(over: Partial<MediaLimits> = {}): MediaLimits {
  return {
    acceptedMimeTypes: new Set(["image/png", "application/pdf"]),
    maxBytesPerItem: 5242880,
    maxRequestBytes: 33554432,
    maxItemsPerRequest: 100,
    maxDimension: 8000,
    ...over,
  }
}

function msg(v: ReturnType<typeof checkMedia>): string {
  if (v.ok) throw new Error("expected a rejection")
  return v.message
}

interface MarkerScenario {
  kind: MediaKind
  mimeType: string
  sizeBytes: number
  width?: number
  height?: number
  modelId?: string
  modalities: Array<keyof ModalitySupport>
  acceptedMimeTypes: string[]
  maxBytesPerItem: number
  maxRequestBytes: number
  maxItemsPerRequest: number
  maxDimension: number | null
}

const WORD: Record<MediaKind, string> = {
  image: "Image",
  audio: "Audio",
  video: "Video",
  document: "File",
}

async function markerText(text: SyntheticTextResolver, sc: MarkerScenario): Promise<string> {
  const id = "0000000a"
  const item: MediaItem = {
    id,
    kind: sc.kind,
    mimeType: sc.mimeType,
    origin: "drop",
    path: null,
    sizeBytes: sc.sizeBytes,
    sha256: "",
    dimensions: sc.width !== undefined ? { width: sc.width, height: sc.height ?? 0 } : null,
    durationSec: null,
    state: "registered",
    bytes: () => Promise.reject(new Error("no bytes")),
    prepared: {},
    createdAt: 0,
  }
  const modalities: ModalitySupport = { ...NO_MODALITY }
  for (const m of sc.modalities) modalities[m] = true
  const out = await resolveMediaTurn({
    text: `[${WORD[sc.kind]} #${id}]`,
    registry: { get: (x: string) => (x === id ? item : undefined) } as unknown as MediaRegistry,
    limits: {
      acceptedMimeTypes: new Set(sc.acceptedMimeTypes),
      maxBytesPerItem: sc.maxBytesPerItem,
      maxRequestBytes: sc.maxRequestBytes,
      maxItemsPerRequest: sc.maxItemsPerRequest,
      maxDimension: sc.maxDimension,
    },
    modalities,
    ...(sc.modelId !== undefined ? { modelId: sc.modelId } : {}),
    prepare: () => Promise.reject(new Error("not attached")),
    syntheticText: text,
  })
  return firstText(out.content as Array<{ type: string; text?: string }>)
}

async function unavailableText(text: SyntheticTextResolver, id: string): Promise<string> {
  const out = await resolveMediaTurn({
    text: `[Image #${id}]`,
    registry: { get: () => undefined } as unknown as MediaRegistry,
    limits: limits(),
    modalities: ALL_MODALITY,
    syntheticText: text,
  })
  return firstText(out.content as Array<{ type: string; text?: string }>)
}

type Run = (t: SyntheticTextResolver, a: unknown[]) => string | Promise<string>

/** Fixture fn to the core call site that makes the text. Same mapping as the core parity tables. */
const RUN: Record<string, Run> = {
  // src/agent/PROMPTS.ts
  turnAbortedAttachmentText: async (t) =>
    firstText(
      await buildInitialUserContent(
        { promptContributors: [], text: t },
        { userText: "", orphanRepair: [], turnMarker: "aborted" },
      ),
    ),
  sessionResumedAttachmentText: async (t) =>
    firstText(
      await buildInitialUserContent(
        { promptContributors: [], text: t },
        { userText: "", orphanRepair: [], turnMarker: "resumed" },
      ),
    ),
  streamInterruptedAttachmentText: async (t) => {
    const out = await nextRoundContent({ promptContributors: [], text: t }, [], true, {})
    return firstText(out.content as Array<{ type: string; text?: string }>)
  },
  outputTruncatedAttachmentText: (t) => continueText(t, true),
  streamInterruptedContinueAttachmentText: (t) => continueText(t, false),
  responseTruncatedPlaceholderText: (t) => placeholderText(t),
  toolExecutionAbortedBeforeCompletionResult: (t) =>
    s(repairOrphanedToolUse(orphanHistory(), null, t)[0]?.content),
  toolCallInterruptedByStopResult: (t) =>
    s(closeInterruptedToolCalls(orphanHistory(), t)[0]?.content),
  // src/agent/synthetic-texts.ts (fixture file: synthetic-fallbacks.ts)
  placeholderText: (t) => placeholderText(t),
  continueText: (t, a) => continueText(t, Boolean(a[0])),
  // src/plugins/loader/PROMPTS.ts
  unknownPluginToolResult: (t, a) => unknownPluginToolText(t, s(a[0])),
  pluginHandlerErrorResult: (t, a) => pluginHandlerErrorText(t, s(a[0])),
  subprocessOutputExceededResult: (t, a) => subprocessOverflowText(t, n(a[0]), s(a[1])),
  // src/tools/PROMPTS.ts
  toolAbortedByUserResult: (t) => T.abortedText(t),
  unknownToolResult: (t, a) => T.unknownToolText(t, s(a[0])),
  modeToolDispatcherBugResult: (t) => T.modeNoExecutorText(t),
  lockTimeoutResult: (t, a) => T.lockTimeoutText(t, s(a[0]), s(a[1])),
  lockAcquireFailedResult: (t, a) => T.lockFailedText(t, s(a[0]), s(a[1])),
  // P3.7 kinds (old text: core 56fc856 inline strings), through the core call sites.
  pluginToolCanceledResult: async (t) => {
    const ctx = { abort: AbortSignal.abort(), trigger: { type: "tool" } }
    const r = await invokeSubprocess("/bin/false", [], ctx as never, t)
    return r.kind === "tool_result" ? s(r.content) : ""
  },
  noToolsExecutorResult: async (t, a) => {
    const toolUse = { type: "tool_use" as const, id: "t1", name: s(a[0]), input: {} }
    return s((await NO_TOOLS_EXECUTOR.execute(toolUse, undefined, { text: t })).content)
  },
  policyDeniedDefault: (t, a) => T.policyDeniedText(t, s(a[0])),
  policyHookFailedResult: (t, a) =>
    T.policyHookFailedText(t, {
      hook: s(a[0]),
      detail: s(a[1]),
      ...(a[2] === undefined ? {} : { label: s(a[2]) }),
    }),
  policyRewriteNote: (t, a) => T.policyRewriteNoteText(t, s(a[0]), n(a[1])),
  stopHookDefaultReason: (t, a) => T.hookDeniedText(t, s(a[0])),
  // src/media/PROMPTS.ts: the bare reason (site "check").
  unsupportedModalityMessage: (t, a) =>
    msg(
      checkMedia(
        { kind: a[1] as MediaKind, mimeType: "x/y", sizeBytes: 1, dimensions: null },
        limits(),
        NO_MODALITY,
        s(a[0]),
        t,
      ),
    ),
  unsupportedTypeMessage: (t, a) =>
    msg(
      checkMedia(
        { kind: "image", mimeType: s(a[0]), sizeBytes: 1, dimensions: null },
        limits(),
        ALL_MODALITY,
        s(a[1]),
        t,
      ),
    ),
  mediaTooLargeMessage: (t, a) => {
    const o = a[0] as Obj
    return msg(
      checkMedia(
        { kind: "image", mimeType: "image/png", sizeBytes: n(o.rawBytes), dimensions: null },
        limits({ maxBytesPerItem: n(o.limitBytes) }),
        ALL_MODALITY,
        s(o.modelId),
        t,
      ),
    )
  },
  mediaDimensionsTooLargeMessage: (t, a) => {
    const o = a[0] as Obj
    return msg(
      checkMedia(
        {
          kind: "image",
          mimeType: "image/png",
          sizeBytes: 1,
          dimensions: { width: n(o.width), height: n(o.height) },
        },
        limits({ maxDimension: n(o.maxDimension) }),
        ALL_MODALITY,
        s(o.modelId),
        t,
      ),
    )
  },
  tooManyAttachmentsMessage: (t, a) => {
    const max = n(a[0])
    const items = Array.from({ length: max + 1 }, () => ({ sizeBytes: 1 }))
    const v = checkMediaSet(items, limits({ maxItemsPerRequest: max }), s(a[1]), t).at(-1)
    if (!v || v.ok) throw new Error("expected a rejection")
    return v.message
  },
  requestTooLargeMessage: (t, a) => {
    const max = n(a[0])
    const [v] = checkMediaSet([{ sizeBytes: max }], limits({ maxRequestBytes: max }), s(a[1]), t)
    if (!v || v.ok) throw new Error("expected a rejection")
    return v.message
  },
  // noModelLabel has no call site of its own: a check with no model id gives
  // the label in the model slot. The fixture text is the label.
  noModelLabel: (t) =>
    msg(
      checkMedia(
        { kind: "image", mimeType: "x/y", sizeBytes: 1, dimensions: null },
        limits(),
        NO_MODALITY,
        undefined,
        t,
      ),
    ).replace(/ does not accept image input$/, ""),
  // src/media/resolve.ts: the whole marker (site "marker") and a stale id.
  mediaRejectedMarker: (t, a) => markerText(t, a[0] as MarkerScenario),
  mediaUnavailableMarker: (t, a) => unavailableText(t, s(a[0])),
}

/**
 * Fixture entries with no core call site that can make their text from facts.
 * `mediaNotSentMarker` took a free reason string and a display token ("PDF")
 * that no media kind maps to. Its composition is covered by the
 * mediaRejectedMarker rows (the whole marker, site "marker") and the shape
 * test below.
 */
const NO_CALL_SITE = new Set(["mediaNotSentMarker"])

describe("turn-recovery parity with the old core texts", () => {
  it("covers every fixture entry of an owned kind", () => {
    expect(rows.length).toBeGreaterThanOrEqual(26)
    for (const e of rows) {
      if (NO_CALL_SITE.has(e.fn)) continue
      expect(RUN[e.fn], `${e.file} ${e.fn}`).toBeDefined()
    }
  })

  for (const e of rows) {
    if (NO_CALL_SITE.has(e.fn)) continue
    it(`${e.file} ${e.fn} (${e.proposedKind})`, async () => {
      const run = RUN[e.fn] as Run
      for (const c of e.cases) {
        const calls: Calls = []
        const out = await run(live(calls), c.args)
        expect(calls.length, e.fn).toBeGreaterThan(0)
        const want = baseKind(e.proposedKind)
        for (const call of calls) {
          if (want.endsWith(".*")) expect(call.kind.startsWith(want.slice(0, -1))).toBe(true)
          else expect(call.kind).toBe(want as SyntheticKind)
        }
        expect(out).toBe(toSte(c.text))
      }
    })
  }

  it("the STE map changes every owned fixture text except the kept ones", () => {
    // Kept on purpose: the core copy at core/src/sdk/tool-calls.ts:96, the
    // core copy at core/src/plugins/hooks/hook-bus.ts:445, short markers that
    // are already STE, and the model label.
    const KEPT = new Set([
      "tool aborted by user",
      'Denied: approval hook "acme:gate" failed (gate down).',
      "Handler error: boom",
      "Unknown tool: Foo",
      "Unknown plugin tool: FooTool",
      "Write error: lock held by session abc for 30000ms",
      "Edit error: lock held by session abc for 30000ms",
      "this model",
      "[image not sent: too large]",
    ])
    for (const e of rows) {
      for (const c of e.cases) {
        if (KEPT.has(c.text) || /^more than \d+ attachments for /.test(c.text)) continue
        if (/^\[\w+ not sent: more than \d+ attachments for /.test(c.text)) continue
        expect(toSte(c.text), `${e.fn}: ${c.text}`).not.toBe(c.text)
      }
    }
  })

  it("each STE mapping rule hits at least one fixture text", () => {
    for (const e of rows) for (const c of e.cases) toSte(c.text)
    const dead = [
      ...RULE_NAMES.prompt.filter((_n, i) => (RULE_HITS.prompt[i] ?? 0) < 1),
      ...RULE_NAMES.inline.filter((_n, i) => (RULE_HITS.inline[i] ?? 0) < 1),
    ]
    expect(dead).toEqual([])
  })

  it("mediaNotSentMarker shape: the marker wraps the check text", () => {
    const e = rows.find((x) => x.fn === "mediaNotSentMarker")
    expect(e).toBeDefined()
    for (const c of e?.cases ?? []) {
      const want = toSte(`[${s(c.args[0]).toLowerCase()} not sent: ${s(c.args[1])}]`)
      expect(toSte(c.text)).toBe(want)
    }
    const base = { reason: "unsupported-modality", modelId: "model-x", mimeType: "x/y" }
    for (const [kind, word] of [
      ["image", "image"],
      ["audio", "audio"],
      ["video", "video"],
      ["document", "file"],
    ] as const) {
      const check = provider.text("user_media.rejected", { ...base, kind, site: "check" })
      const marker = provider.text("user_media.rejected", { ...base, kind, site: "marker" })
      expect(marker).toBe(`[${word} not sent: ${check}]`)
    }
  })
})

describe("turn-recovery kinds", () => {
  it("provider.kinds equals the manifest kinds", () => {
    const m = manifest as { syntheticText: Array<{ kinds?: string[] }> }
    expect(m.syntheticText).toHaveLength(1)
    const own: string[] = [...provider.kinds].sort()
    expect(own).toEqual([...(m.syntheticText[0]?.kinds ?? [])].sort())
  })
  it("the manifest is required", () => {
    expect((manifest as { required?: boolean }).required).toBe(true)
  })
})

describe("formatBytes parity with core (N1)", () => {
  it("matches core formatBytes on every boundary and a sweep", () => {
    const KB = 1024
    const MB = KB * KB
    const GB = MB * KB
    const values = new Set<number>([
      0, 1, 2, 511, 512, 513, 900, 1000, 1023, 1024, 1025, 1535, 1536, 1537,
    ])
    for (const unit of [KB, MB, GB]) {
      for (const k of [1, 2, 5, 10, 100, 1000, 1023, 1024, 1025]) {
        for (const d of [-1, 0, 1]) values.add(k * unit + d)
        values.add(k * unit + unit / 2)
        values.add(k * unit - unit / 2)
        values.add(Math.round(k * unit * 1.05))
        values.add(Math.round(k * unit * 1.95))
      }
    }
    for (let i = 0; i < 4096; i++) values.add(i)
    for (let i = 0; i < 2000; i++) values.add(Math.floor(i * 5237.7))
    for (let i = 0; i < 2000; i++) values.add(Math.floor(i * 5_368_709.3))
    for (let i = 0; i < 500; i++) values.add(Math.floor(i * 11_811_160_064.7))
    for (const v of [6000000, 8000000, 5242880, 33554432, 1048576, 3000000, 1200, 4000000])
      values.add(v)
    for (const v of values) expect(formatBytes(v), String(v)).toBe(coreFormatBytes(v))
    expect(values.size).toBeGreaterThan(8000)
  })
})
