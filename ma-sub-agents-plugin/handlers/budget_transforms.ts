/**
 * Worker-side soft budget warnings: one `stamp` stage of the core tool-result
 * chain (manifest `toolResultTransforms`, sideband kind `budget`).
 *
 * At each tool result the stage asks {@link nextBudgetWarning}. When a level
 * fires (once each), it adds one `budget` annotation. Core renders the text
 * from the sideband registry and puts it at the tail of the tool_result, after
 * the mode stamp, for example:
 *
 * `<ma::agent::budget elapsed="1350" remaining="450" level="warn">You used ...</ma::agent::budget>`
 *
 * Worker only. The module default export is a factory: in a process with no
 * `MINIMAL_AGENT_SUBAGENT_RESULT_PATH` (a lead) it returns `[]`, so the lead
 * chain has no stage and the lead requests stay byte-identical. The stage also
 * checks the env at each call.
 *
 * Turn count: the stage reads the worker's OWN stream file
 * (`<sessionsDir>/<sid>.stream.ndjson`, the stdout capture that the lead set
 * up) with the same `streamReader` and `turn_started.turn` fold that the
 * supervisor uses for `maxTurns`. So the two counts agree by construction. A
 * count in the plugin (tool batches) would drift: a turn with no tool call
 * gives no stage call, and parallel tool calls give more than one. The read is
 * incremental and cached, so each call reads only the new bytes. When the file
 * is absent, the count is 0 and only the time thresholds apply.
 *
 * @module sub-agents/handlers/budget_transforms
 */

import { basename, dirname } from "node:path"

import type {
  ToolResultStage,
  ToolResultTransformDecl,
} from "@minimal-agent/core/plugin-api/types/tool-result-chain"

import {
  BUDGET_TEXT,
  type BudgetLatch,
  type BudgetWarning,
  createLatch,
  nextBudgetWarning,
} from "../lib/budget-warning.ts"
import { ENV_RESULT_PATH, streamPathFor } from "../lib/spawn.ts"
import { ENV_SID } from "../lib/spawn-plan.ts"
import { streamReader } from "../lib/stream.ts"

/** The sideband kind of the annotation (manifest `sideband`). */
export const BUDGET_KIND = "budget"

type Env = Readonly<Record<string, string | undefined>>

/** Injectable inputs of the stage. */
export interface BudgetStageDeps {
  /** The env at the call. */
  readonly env: () => Env
  /** Epoch ms at this time. */
  readonly now: () => number
  /** The newest started turn of this worker (0 when unknown). */
  readonly turnsUsed: (env: Env) => number
  /** The once-per-level latch of this boot. */
  readonly latch: BudgetLatch
}

/** True in a worker: the lead set the result sentinel path. */
export function isWorker(env: Env): boolean {
  return Boolean(env[ENV_RESULT_PATH]?.trim())
}

/**
 * The stream file of this worker. The lead writes the sentinel and the stream
 * in the same sessions dir (`service.ts`), and the sid is in `ENV_SID`.
 */
export function ownStreamPath(env: Env): string | undefined {
  const result = env[ENV_RESULT_PATH]?.trim()
  if (!result) return undefined
  const sid = env[ENV_SID]?.trim() || basename(result).replace(/\.result\.json$/, "")
  return sid ? streamPathFor(dirname(result), sid) : undefined
}

/**
 * The production turn reader: the supervisor fold over the own stream.
 * The read is incremental (only new bytes), but one call can read up to the
 * 4 MB cap of `streamReader` synchronously on the tool-result path. After a
 * very large append, the turn count can be late by some calls. Late only, not
 * wrong: the next calls read the rest.
 */
function realTurnsUsed(): (env: Env) => number {
  const read = streamReader()
  return (env) => {
    const path = ownStreamPath(env)
    if (!path) return 0
    try {
      return read(path)?.turns ?? 0
    } catch {
      return 0
    }
  }
}

/** The annotation that core renders as the `budget` tag. */
export function budgetAnnotation(w: BudgetWarning): ToolResultStage["annotations"][number] {
  return {
    kind: BUDGET_KIND,
    attrs: {
      elapsed: w.elapsed,
      remaining: w.remaining,
      ...(w.turnsLeft !== undefined ? { "turns-left": w.turnsLeft } : {}),
      level: w.level,
    },
    body: BUDGET_TEXT[w.level],
    // Core replaces `text` with the rendered tag (owner rule 5).
    text: "",
    join: "\n\n",
    // Core sets the owner from the plugin id. This value has no effect.
    owner: "sub-agents",
  }
}

/**
 * Build the stamp stage.
 *
 * @param deps - The env, the clock, the turn reader and the latch.
 * @returns One `stamp` decl.
 */
export function createBudgetStage(deps: BudgetStageDeps): ToolResultTransformDecl {
  return {
    phase: "stamp",
    order: 0,
    transform: (s) => {
      const env = deps.env()
      if (!isWorker(env)) return s
      const w = nextBudgetWarning(env, deps.now(), deps.turnsUsed(env), deps.latch)
      if (!w) return s
      return { ...s, annotations: [...s.annotations, budgetAnnotation(w)] }
    },
  }
}

/**
 * The chain factory that core calls once at boot. A lead gets `[]`.
 *
 * @param env - The process env (default `process.env`).
 * @returns The decls of this plugin.
 */
export default function budgetTransforms(
  env: Env = process.env,
): readonly ToolResultTransformDecl[] {
  if (!isWorker(env)) return []
  return [
    createBudgetStage({
      env: () => process.env,
      now: () => Date.now(),
      turnsUsed: realTurnsUsed(),
      // One latch per boot: core calls this factory once per plugin load, so
      // each level fires at most once in a worker process. A module-global
      // latch would leak between loads in one test process.
      latch: createLatch(),
    }),
  ]
}
