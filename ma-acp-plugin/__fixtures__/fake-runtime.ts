/**
 * Test fixture: an in-memory {@link HostRuntime} with a tiny model table
 * and the same setter rules core's `AgentCore.setModel` / `setEffort`
 * follow (throw on unknown id or bad level with state unchanged; a model
 * change resets an effort the new model does not support to `undefined`).
 * The session's `run` replays a scripted list of events.
 *
 * @module __fixtures__/fake-runtime
 */

import type { HostRuntime, HostSession } from "@minimal-agent/core/host-kit/host-mode"
import type { ModelInfoSnapshot } from "@minimal-agent/core/plugin-api/types/plugin"
import type { AgentEvent } from "@minimal-agent/core/sdk/events"

/** One fake model: id, label, context window, effort levels. */
export interface FakeModel {
  readonly id: string
  readonly label: string
  readonly contextWindow: number
  readonly levels: readonly string[]
  readonly defaultEffort: string
}

/** Default table: `alpha` has low/medium/high, `beta` has none, `gamma` has low/high. */
export const FAKE_MODELS: readonly FakeModel[] = [
  {
    id: "alpha",
    label: "Alpha",
    contextWindow: 200_000,
    levels: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  { id: "beta", label: "Beta", contextWindow: 128_000, levels: [], defaultEffort: "medium" },
  {
    id: "gamma",
    label: "Gamma",
    contextWindow: 1_000_000,
    levels: ["low", "high"],
    defaultEffort: "high",
  },
]

/** What one scripted turn does. */
export interface ScriptedTurn {
  readonly events: readonly AgentEvent[]
  readonly outcome: "completed" | "truncated" | "failed" | "aborted" | "waiting"
  /** Throw this from the iterable instead of resolving. */
  readonly throws?: Error
  /** Wait for the abort signal before ending (to test cancel). */
  readonly waitForAbort?: boolean
  /** Runs before the events, e.g. to simulate core adopting a model. */
  readonly before?: (runtime: FakeRuntime) => void
  /** `ch: "diag"` entries to yield after the events (`data` of each entry). */
  readonly diags?: readonly { readonly code: string; readonly message?: string }[]
}

/**
 * The `options` of one `session.run` call. Typed locally: the pinned core
 * has no `outputSchema` (D1) or `temperature` (D4) run option.
 */
export interface FakeRunOptions {
  readonly emitDeltas?: boolean
  readonly outputSchema?: object
  readonly temperature?: number
}

/**
 * The `capabilities` object the CLI puts on the runtime (CLI
 * `HostRuntimeCapabilities`). Typed locally: core's `HostRuntime` does not
 * declare it.
 */
export interface FakeCapabilities {
  readonly systemPrompt: { readonly append: boolean; readonly override: boolean }
  readonly outputSchema: boolean
  readonly temperature: boolean
}

/** Every capability on: the default, so a test sees the full feature set. */
export const ALL_CAPABILITIES: FakeCapabilities = {
  systemPrompt: { append: true, override: true },
  outputSchema: true,
  temperature: true,
}

/** The fake runtime plus test hooks. */
export interface FakeRuntime extends HostRuntime {
  model: string
  effort: string | undefined
  readonly turns: ScriptedTurn[]
  readonly prompts: string[]
  /** How many times `session.close()` ran. */
  closeCalls: number
  /** True when the signal of the last `run` call fired. */
  lastRunAborted: boolean
  /**
   * The `options` argument of each `openSession` call (`undefined` when
   * called with none). Typed locally: the pinned core has no
   * `HostOpenSessionOptions`.
   */
  readonly openSessionCalls: Array<
    { readonly systemPrompt?: { readonly mode: string; readonly text: string } } | undefined
  >
  /** The options of each `session.run` call, without the signal. */
  readonly runOptions: FakeRunOptions[]
  /** Absent when built with `capabilities: null` (an older CLI). */
  readonly capabilities?: FakeCapabilities
}

function snapshot(m: FakeModel): ModelInfoSnapshot {
  return {
    modelId: m.id,
    displayName: m.label,
    providerId: "fake",
    surfaceId: "fake",
    contextWindow: m.contextWindow,
    maxOutputTokens: 8192,
    modalities: { image: false, audio: false, pdf: false, video: false },
    acceptedInput: {},
    thinking: { adaptive: false, extended: false, visible: false, interleaved: false },
    effort: { levels: [...m.levels], default: m.defaultEffort },
    caching: { explicit: false, automatic: false, ttls: [], reportsCacheHits: false },
    tools: { userDefined: true, parallel: false },
    serverTools: [],
    pricing: { inputPerMTok: 0, outputPerMTok: 0, cacheWritePerMTok: 0, cacheReadPerMTok: 0 },
    resolved: true,
  }
}

/**
 * Build a fake runtime starting on `model` with `effort`. `capabilities`
 * defaults to {@link ALL_CAPABILITIES}. `null` leaves the field out (an
 * older CLI with no capabilities object).
 */
export function createFakeRuntime(
  start: { model?: string; effort?: string; capabilities?: FakeCapabilities | null } = {},
  models: readonly FakeModel[] = FAKE_MODELS,
): FakeRuntime {
  const find = (id: string): FakeModel | undefined => models.find((m) => m.id === id)
  const capabilities = start.capabilities === undefined ? ALL_CAPABILITIES : start.capabilities
  const rt: FakeRuntime = {
    ...(capabilities ? { capabilities } : {}),
    model: start.model ?? "alpha",
    effort: start.effort,
    turns: [],
    prompts: [],
    closeCalls: 0,
    lastRunAborted: false,
    openSessionCalls: [],
    runOptions: [],
    openSession(...args: unknown[]): Promise<HostSession> {
      rt.openSessionCalls.push(args[0] as FakeRuntime["openSessionCalls"][number])
      const session: HostSession = {
        sessionId: "sess_fake",
        run(input, options) {
          rt.prompts.push(input)
          const { signal: _signal, ...rest } = options as FakeRunOptions & { signal: AbortSignal }
          rt.runOptions.push(rest)
          rt.lastRunAborted = false
          options.signal.addEventListener(
            "abort",
            () => {
              rt.lastRunAborted = true
            },
            { once: true },
          )
          const turn = rt.turns.shift() ?? { events: [], outcome: "completed" }
          let settle: (v: { outcome: ScriptedTurn["outcome"] }) => void = () => {}
          const result = new Promise<{ outcome: ScriptedTurn["outcome"] }>((r) => {
            settle = r
          })
          async function* gen() {
            turn.before?.(rt)
            for (const data of turn.events) {
              await Bun.sleep(0)
              yield { ch: "event", data }
            }
            for (const d of turn.diags ?? []) {
              await Bun.sleep(0)
              yield {
                ch: "diag",
                data: { severity: 4, facility: 1, message: d.message ?? d.code, ...d },
              }
            }
            if (turn.waitForAbort) {
              await new Promise<void>((r) => {
                if (options.signal.aborted) r()
                else options.signal.addEventListener("abort", () => r(), { once: true })
              })
            }
            if (turn.throws) throw turn.throws
            settle({ outcome: turn.outcome })
          }
          return Object.assign(gen(), { result }) as unknown as ReturnType<HostSession["run"]>
        },
        answer: () => false,
        close: async () => {
          rt.closeCalls += 1
        },
      }
      return Promise.resolve(session)
    },
    listModels: () => models.map((m) => ({ id: m.id, label: m.label })),
    modelInfo: (id) => {
      const m = find(id)
      return m ? snapshot(m) : undefined
    },
    getModel: () => rt.model,
    setModel(id) {
      const m = find(id)
      if (!m) throw new Error(`unknown model ${id}`)
      rt.model = id
      if (rt.effort !== undefined && !m.levels.includes(rt.effort)) rt.effort = undefined
    },
    getEffort: () => rt.effort,
    setEffort(level) {
      const m = find(rt.model)
      if (level !== undefined && !m?.levels.includes(level)) {
        throw new Error(`effort ${level} not supported by ${rt.model}`)
      }
      rt.effort = level
    },
  }
  return rt
}
