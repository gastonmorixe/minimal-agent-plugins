/**
 * No core fallback (core-prompts decouple P2.4). Runs every request golden
 * scenario with the real first-party plugins and proves that core used none
 * of its own fallback text:
 *
 * (a) every synthetic text resolve() went to a provider: the loader's
 *     resolver is wrapped, and a kind with no owner or a call of the
 *     call-site `fallback()` is recorded.
 * (b) system[0] is the identity of ma-base-prompt-plugin, and system[1] is
 *     its slot parts for the same ctx, joined with a blank line.
 * (c) the built-in tools of the first request equal
 *     buildToolDefinitions([ma-core-tools-plugin provider]), and the provider
 *     owns every built-in tool name.
 *
 * Goldens are not compared here (request-golden.test.ts does that). Core source
 * is imported through the installed package directory
 * (`node_modules/@minimal-agent/core`), never through a sibling checkout: see
 * `scripts/no-sibling-core-imports.test.ts`.
 */

import { describe, expect, it } from "bun:test"

import type {
  SyntheticFacts,
  SyntheticKind,
} from "@minimal-agent/core/plugin-api/types/synthetic-text"

import createBasePromptProvider from "../../ma-base-prompt-plugin/provider.ts"
import { createCoreToolTextProvider } from "../../ma-core-tools-plugin/provider.ts"
import {
  DEFAULT_REFLECTION_COOLDOWN_MS,
  DEFAULT_REFLECTION_INTERVAL,
} from "../../node_modules/@minimal-agent/core/src/agent/reflection.ts"
import type { SyntheticTextResolver } from "../../node_modules/@minimal-agent/core/src/agent/synthetic-text.ts"
import { buildToolDefinitions } from "../../node_modules/@minimal-agent/core/src/tools/tool-definitions.ts"

import { runScenario } from "./harness.ts"
import { SCENARIOS } from "./scenarios.ts"

/** One fallback finding. */
interface Finding {
  scenario: string
  seam: "synthetic" | "system" | "tools"
  what: string
}

const findings: Finding[] = []
const resolvedKinds = new Set<string>()

/**
 * Wrap a resolver: record each kind. Core has no fallback text, so a kind
 * that no plugin owns, or an owned kind that resolves to "", is a finding.
 */
function recording(
  inner: SyntheticTextResolver,
  owned: ReadonlySet<string>,
  scenario: string,
): SyntheticTextResolver {
  return {
    resolve(kind: SyntheticKind, facts: SyntheticFacts): string {
      resolvedKinds.add(kind)
      if (!owned.has(kind)) findings.push({ scenario, seam: "synthetic", what: `unowned ${kind}` })
      const text = inner.resolve(kind, facts)
      if (text === "")
        findings.push({ scenario, seam: "synthetic", what: `empty text for ${kind}` })
      return text
    },
  }
}

const baseProvider = createBasePromptProvider()
const toolText = createCoreToolTextProvider()
const pluginTools = buildToolDefinitions([toolText])
const builtinNames = buildToolDefinitions().map((t) => t.name)

const textOf = (block: unknown): string | undefined =>
  (block as { text?: unknown } | undefined)?.text as string | undefined

function checkSystem(
  scenario: (typeof SCENARIOS)[number],
  first: Record<string, unknown>,
  home: string,
): void {
  const system = first.system as unknown[] | undefined
  const identity = baseProvider.identity?.({ authKind: "api-key", modelId: "test-model" })
  if (textOf(system?.[0]) !== identity) {
    findings.push({ scenario: scenario.name, seam: "system", what: "identity" })
  }
  const parts =
    baseProvider.instructionParts?.({
      agentHome: home,
      reflectionInterval: DEFAULT_REFLECTION_INTERVAL,
      reflectionCooldownMs: DEFAULT_REFLECTION_COOLDOWN_MS,
      // Core sends the tool-output-conventions slot when the executor has an
      // enabled blob store (follow-up 15b). The harness gives one per scenario.
      blobStoreEnabled: scenario.blobStore === true,
    } as never) ?? []
  const block = textOf(system?.[1]) ?? ""
  for (const p of parts) {
    if (!block.includes(p.text)) {
      findings.push({ scenario: scenario.name, seam: "system", what: `slot ${p.slot}` })
    }
  }
  if (block !== parts.map((p) => p.text).join("\n\n")) {
    findings.push({ scenario: scenario.name, seam: "system", what: "instructions block bytes" })
  }
}

function checkTools(scenario: string, first: Record<string, unknown>): void {
  const tools = (first.tools as Array<{ name: string }> | undefined) ?? []
  const sent = tools.filter((t) => builtinNames.includes(t.name))
  if (sent.length === 0) findings.push({ scenario, seam: "tools", what: "no built-in tool sent" })
  for (const t of sent) {
    const expected = pluginTools.find((p) => p.name === t.name)
    if (JSON.stringify(t) !== JSON.stringify(expected)) {
      findings.push({ scenario, seam: "tools", what: `tool ${t.name}` })
    }
  }
}

describe("no core fallback with the real plugins", () => {
  it("the tool text provider owns every built-in tool", () => {
    expect(builtinNames.filter((n) => !toolText.tools.includes(n))).toEqual([])
  })

  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const before = findings.length
      let sawLoader = false
      await runScenario(scenario, {
        onLoader: (loader) => {
          sawLoader = true
          const owned = new Set<string>(loader.syntheticTextProviders().flatMap((p) => p.kinds))
          const wrapped = recording(loader.syntheticText(), owned, scenario.name)
          loader.syntheticText = () => wrapped
        },
        onRequests: (requests, { home }) => {
          const first = requests[0]
          if (!first) {
            findings.push({ scenario: scenario.name, seam: "system", what: "no request" })
            return
          }
          // noExecutor builds a bare AgentCore with no loader: core text by design.
          if (scenario.noExecutor) return
          checkSystem(scenario, first, home)
          checkTools(scenario.name, first)
        },
      })
      expect(sawLoader).toBe(true)
      expect(findings.slice(before)).toEqual([])
    }, 120_000)
  }

  it("resolved at least one synthetic kind across the run", () => {
    expect(resolvedKinds.size).toBeGreaterThan(0)
  })
})
