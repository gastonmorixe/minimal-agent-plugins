/**
 * F1 anchor + F2 append-only thinking, through the real plugins and a real
 * AgentCore: a 3-round tool loop with signed thinking on a keep-all model
 * (claude-opus-5-5, capability data from ma-llm-anthropic-plugin). Checks the
 * marker positions and count, and that the older messages are byte-identical
 * between consecutive requests. The default run (no flags) has the anchor
 * (ON by default) and keeps today's strip. With `cacheAnchor: false` it has
 * one marker. No golden file: the checks are structural.
 */

import { writeFileSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import {
  clearModelRegistry,
  type ModelEntry,
  registerModel,
} from "@minimal-agent/core/host/model-registry"
import {
  type AnthropicRequestBody,
  capCacheMarkers,
  countCacheMarkers,
} from "@minimal-agent/core/plugin-api/llm/anthropic-request"

import { registerAnthropicModels } from "../../ma-llm-anthropic-plugin/models.ts"

import { runScenario, type Scenario } from "./harness.ts"

type Block = Record<string, unknown> & { type: string; cache_control?: unknown }
type Msg = { role: string; content: string | Block[] }
type Req = { messages: Msg[]; system?: Block[] }

const script: Scenario["script"] = [
  { thinking: "plan a", tools: [{ name: "Read", input: { file_path: "a.txt" } }] },
  { thinking: "plan b", tools: [{ name: "Read", input: { file_path: "b.txt" } }] },
  { thinking: "plan c", tools: [{ name: "Read", input: { file_path: "c.txt" } }] },
  { thinking: "wrap up", text: "done" },
]

async function requests(extra: Record<string, unknown>): Promise<Req[]> {
  let out: Req[] = []
  await runScenario(
    {
      name: "cache-anchor-append-only",
      script,
      setup: (cwd) => {
        for (const f of ["a", "b", "c"]) writeFileSync(`${cwd}/${f}.txt`, `${f}\n`)
      },
      coreDeps: () => ({ model: "claude-opus-5-5", providerId: "anthropic", ...extra }),
      run: async ({ turn }) => {
        await turn("read the three files")
      },
    },
    { onRequests: (r) => (out = JSON.parse(JSON.stringify(r)) as Req[]) },
  )
  return out
}

/** [message index, block index] of each message marker. */
function markers(req: Req): Array<[number, number]> {
  const out: Array<[number, number]> = []
  req.messages.forEach((m, i) => {
    if (typeof m.content === "string") return
    m.content.forEach((b, j) => {
      if (b.cache_control) out.push([i, j])
    })
  })
  return out
}

const systemMarkers = (req: Req) => (req.system ?? []).filter((b) => b.cache_control).length
const thinkingCount = (req: Req) =>
  req.messages
    .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
    .filter((b) => b.type === "thinking").length
const strip = (m: Msg): string =>
  JSON.stringify(
    typeof m.content === "string"
      ? m
      : { ...m, content: m.content.map(({ cache_control: _c, ...rest }) => rest) },
  )

describe("request golden: anchor + append-only thinking (F1/F2)", () => {
  // The harness loads plugins without provider activation, so the catalog is
  // not in the host registry. Register the real Anthropic capability data.
  beforeAll(() => {
    registerAnthropicModels({
      register: (spec) => registerModel(spec as unknown as ModelEntry),
      setDefault: () => {},
    })
  })
  afterAll(() => clearModelRegistry())

  test("flags on: anchor before the latest assistant, tail last, all thinking kept", async () => {
    const reqs = await requests({ cacheAnchor: true, thinkingHistory: "keep" })
    expect(reqs).toHaveLength(4)
    // Request i (0-based) has 2i+1 messages; the tail is on the last one.
    expect(markers(reqs[0])).toEqual([[0, 0]])
    expect(markers(reqs[1])).toEqual([[2, 0]])
    expect(markers(reqs[2])).toEqual([
      [2, 0],
      [4, 0],
    ])
    expect(markers(reqs[3])).toEqual([
      [4, 0],
      [6, 0],
    ])
    // Every assistant turn keeps its signed thinking.
    expect(reqs.map(thinkingCount)).toEqual([0, 1, 2, 3])
    // F3: the oauth-shaped system has 3 markers, so the last request has 5
    // markers before the wire build. The wire cap drops the anchor, keeps the tail.
    expect(systemMarkers(reqs[3])).toBe(3)
    const wire = JSON.parse(
      JSON.stringify({
        model: "m",
        max_tokens: 1,
        system: reqs[3].system,
        messages: reqs[3].messages,
      }),
    ) as AnthropicRequestBody
    expect(countCacheMarkers(wire)).toBe(5)
    expect(capCacheMarkers(wire)).toBe(1)
    expect(countCacheMarkers(wire)).toBe(4)
    expect(markers(wire as unknown as Req)).toEqual([[6, 0]])
    // Append-only: each request's messages are a byte-identical prefix of the next
    // (markers aside), and the previous tail is the new anchor with the same bytes.
    for (let i = 1; i < reqs.length; i++) {
      const prev = reqs[i - 1].messages
      const next = reqs[i].messages
      for (let k = 0; k < prev.length; k++) expect(strip(next[k])).toBe(strip(prev[k]))
      if (i >= 2) {
        expect(JSON.stringify(next[prev.length - 1])).toBe(JSON.stringify(prev[prev.length - 1]))
      }
    }
  })

  test("default (no flags): the anchor is ON, today's strip of older thinking", async () => {
    const reqs = await requests({})
    expect(reqs.map(markers)).toEqual([
      [[0, 0]],
      [[2, 0]],
      [
        [2, 0],
        [4, 0],
      ],
      [
        [4, 0],
        [6, 0],
      ],
    ])
    // Only the latest assistant turn keeps its thinking.
    expect(reqs.map(thinkingCount)).toEqual([0, 1, 1, 1])
    // F3 holds: 3 system markers + anchor + tail is 5, the cap keeps 4 (drops the anchor).
    const wire = JSON.parse(
      JSON.stringify({
        model: "m",
        max_tokens: 1,
        system: reqs[3].system,
        messages: reqs[3].messages,
      }),
    ) as AnthropicRequestBody
    expect(countCacheMarkers(wire)).toBe(systemMarkers(reqs[3]) + 2)
    capCacheMarkers(wire)
    expect(countCacheMarkers(wire)).toBeLessThanOrEqual(4)
    expect(markers(wire as unknown as Req)).toContainEqual([6, 0])
  })

  test("cacheAnchor: false: one tail marker and today's strip of older thinking", async () => {
    const reqs = await requests({ cacheAnchor: false })
    expect(reqs.map((r) => markers(r).length)).toEqual([1, 1, 1, 1])
    expect(reqs.map(thinkingCount)).toEqual([0, 1, 1, 1])
  })
})
