/**
 * Build the injected deps for the Service Layer + supervisor from a live
 * handler context. This is the ONE place the plugin reaches for real OS
 * collaborators (`Bun.spawn`, `process.kill`, `crypto.randomUUID`), keeping
 * every other module pure + testable.
 *
 * @module sub-agents/lib/handler-deps
 */

import { randomUUID } from "node:crypto"

import type { LiveAreaHandlerContext, TUIContext } from "../lib/host-types.ts"

import { resolveDefinition } from "./library.ts"
import { presenceDir } from "./presence.ts"
import {
  resolveAgentBin,
  resolveAutoTier,
  resolveDepth,
  resolveModelOverride,
  resolvePolicy,
  resolveSessionsDir,
  resolveTokenBudget,
} from "./runtime.ts"
import { type ServiceDeps } from "./service.ts"
import { realProbeDeps, realSpawnDeps } from "./spawn.ts"
import { SubagentStore } from "./store.ts"
import { type SupervisorDeps } from "./supervisor-shell.ts"
import { sessionId } from "./types.ts"

/**
 * Resolve the default worker model, model/provider-AGNOSTICALLY.
 *
 * Precedence (highest first):
 *   1. `MINIMAL_AGENT_SUBAGENT_MODEL` env override.
 *   2. The LEAD's CURRENT live model via `ctx.queryModelInfo()` — the host fills
 *      this from the shared registry that provider plugins populate, so we stay
 *      decoupled from any specific provider and pick up mid-session model
 *      switches.
 *   3. The lead identity's frozen-at-boot model (`ctx.agent.model`) as a
 *      fallback when the live query isn't wired (subprocess/back-compat).
 *   4. `""` — nothing knowable: the spawn plan OMITS `--model` and the child
 *      self-resolves through its own `userConfig.model ?? DEFAULT_MODEL`.
 *
 * A per-spawn `model` (handled in the service) overrides all of these.
 */
function resolveLeadModel(ctx: TUIContext): string {
  const override = resolveModelOverride(ctx.env)
  if (override) return override
  const live = ctx.queryModelInfo?.()?.modelId?.trim()
  if (live) return live
  return ctx.agent?.model?.trim() || ""
}

/**
 * Resolve the LEAD's live provider id (e.g. `"grok"`), or `""` when unknown.
 *
 * Comes only from `ctx.queryModelInfo()?.providerId` — the same live snapshot
 * the host already scopes with `getLiveProviderId()`. We do NOT re-derive the
 * provider from an unscoped model-registry lookup: bare model ids can be
 * dual-registered (e.g. `grok-4.5` under both `grok` and `opencode`), and
 * last-write-wins would silently hand workers the wrong gateway (Lisa bug:
 * lead on Grok, workers on OpenCode Go → CreditsError 401).
 */
function resolveLeadProvider(ctx: TUIContext): string {
  return ctx.queryModelInfo?.()?.providerId?.trim() || ""
}

/**
 * Build `resolveProvider` for the service layer.
 *
 * When the worker reuses the LEAD's LIVE model id, pin the lead's live
 * provider so dual-registered bare ids stay on the gateway the user selected.
 * Comparison is against the live snapshot model id (not `defaultModel`), so an
 * env model override to a *different* SKU does not inherit the lead provider.
 * For any other model id (per-spawn override, role recommendation, env
 * override that differs from the live model), fall back to the unscoped host
 * registry `models.find` (best-effort; may still be ambiguous, but that path
 * is an explicit different model pick).
 */
function makeResolveProvider(
  ctx: TUIContext,
): ((modelId: string) => string | undefined) | undefined {
  const leadProvider = resolveLeadProvider(ctx)
  // Live model only — not env override / defaultModel — so a forced different
  // SKU does not get the lead's provider stamped on it.
  const liveModelId = ctx.queryModelInfo?.()?.modelId?.trim() || ctx.agent?.model?.trim() || ""
  const hasRegistry = Boolean(ctx.host?.models?.find)
  if (!leadProvider && !hasRegistry) return undefined

  return (modelId: string): string | undefined => {
    const id = modelId.trim()
    if (id.length === 0) return undefined
    // Inherit the lead provider only for the lead's own live model id.
    if (leadProvider && liveModelId && id === liveModelId) return leadProvider
    return ctx.host?.models?.find(id)?.providerId?.trim() || undefined
  }
}

/**
 * Map an abstract role → the ACTIVE provider's recommended model + settings,
 * via `ctx.recommendSubagentModels` ONLY (no registry/provider import, so the
 * plugin stays decoupled). Returns `undefined` (so the caller inherits the
 * lead's own model) in three cases:
 *
 *   1. Auto-tiering is OFF. This is the DEFAULT. Without an explicit opt-in we
 *      never let a role recommendation override the lead's model, because that
 *      is exactly the silent downgrade users hit: spawn `explorer` on Opus and
 *      land on Haiku, spawn `worker` and land on Sonnet. A worker inherits the
 *      model the user is paying for. Opt in with
 *      `MINIMAL_AGENT_SUBAGENT_AUTO_TIER=1` to restore cheap-scout behavior.
 *   2. An explicit env model override is set (the user's pick wins over a
 *      provider suggestion).
 *   3. The host wired no provider recommendation port.
 */
function makeRecommendForRole(
  ctx: TUIContext,
): ((role: string) => { modelId: string; effort?: string } | undefined) | undefined {
  if (!resolveAutoTier(ctx.env)) return undefined
  if (resolveModelOverride(ctx.env)) return undefined
  const query = ctx.recommendSubagentModels
  if (!query) return undefined
  return (role: string) => {
    for (const r of query()) {
      if (r.role === role && r.modelId.trim().length > 0) {
        return { modelId: r.modelId, ...(r.effort ? { effort: r.effort } : {}) }
      }
    }
    return undefined
  }
}

/**
 * Effort levels known for a model id, for pre-launch validation.
 *
 * Prefers the LEAD live snapshot (`queryModelInfo().effort.levels`) when the
 * worker reuses the lead model id — that snapshot is already scoped to the
 * lead provider, so dual-registered bare ids (grok vs opencode `grok-4.5`)
 * don't pick the wrong catalog. Falls back to the host registry entry's
 * capabilities for a different model id. Returns `undefined` when nothing
 * is known so spawn stays forward-compatible.
 */
function makeEffortLevelsForModel(
  ctx: TUIContext,
): ((modelId: string) => readonly string[] | undefined) | undefined {
  const live = ctx.queryModelInfo?.()
  const liveModelId = live?.modelId?.trim() || ctx.agent?.model?.trim() || ""
  const liveLevels = live?.effort?.levels
  const hasRegistry = Boolean(ctx.host?.models?.find)
  if ((!liveLevels || liveLevels.length === 0) && !hasRegistry) return undefined

  return (modelId: string): readonly string[] | undefined => {
    const id = modelId.trim()
    if (id.length === 0) return undefined
    if (liveModelId && id === liveModelId && liveLevels && liveLevels.length > 0) {
      return liveLevels
    }
    const entry = ctx.host?.models?.find(id) as
      | { capabilities?: { effort?: { levels?: readonly string[] } } }
      | undefined
    const levels = entry?.capabilities?.effort?.levels
    return levels && levels.length > 0 ? levels : undefined
  }
}

/** Build {@link ServiceDeps} for a tool handler, or `null` when no session id is plumbed. */
export function serviceDepsFromCtx(ctx: TUIContext): ServiceDeps | null {
  const leadSid = ctx.agent?.sessionId
  if (!leadSid) return null
  const sessionsDir = resolveSessionsDir(ctx.env)
  const recommendForRole = makeRecommendForRole(ctx)
  const defaultModel = resolveLeadModel(ctx)
  const resolveProvider = makeResolveProvider(ctx)
  const effortLevelsForModel = makeEffortLevelsForModel(ctx)
  return {
    store: new SubagentStore(leadSid, { dir: sessionsDir }),
    spawnDeps: realSpawnDeps(),
    agentBin: resolveAgentBin(ctx.env, process.argv),
    leadSid: sessionId(leadSid),
    depth: resolveDepth(ctx.env),
    cwd: ctx.cwd,
    sessionsDir,
    defaultModel,
    newSid: () => randomUUID(),
    now: () => new Date(),
    resolveDefinition,
    ...(recommendForRole ? { recommendForRole } : {}),
    ...(resolveProvider ? { resolveProvider } : {}),
    ...(effortLevelsForModel ? { effortLevelsForModel } : {}),
    policy: resolvePolicy(ctx.env),
    // Pass the lead's own plugin-disable list through so the spawn plan unions
    // it with the worker-only disables (intercom) rather than dropping it.
    ...(ctx.env.MINIMAL_AGENT_DISABLE_PLUGINS
      ? { disabledPlugins: ctx.env.MINIMAL_AGENT_DISABLE_PLUGINS }
      : {}),
  }
}

/** A store bound to the lead session (for read-only handlers), or `null`. */
export function storeFromCtx(ctx: TUIContext): SubagentStore | null {
  const leadSid = ctx.agent?.sessionId
  if (!leadSid) return null
  return new SubagentStore(leadSid, { dir: resolveSessionsDir(ctx.env) })
}

/** The sessions dir for a tool handler (where child `.log` / `.result.json` live). */
export function sessionsDirFromCtx(ctx: TUIContext): string {
  return resolveSessionsDir(ctx.env)
}

/** Build {@link SupervisorDeps} for the heartbeat slot, or `null` when no session id. */
export function supervisorDepsFromCtx(ctx: LiveAreaHandlerContext): SupervisorDeps | null {
  const leadSid = ctx.agent?.sessionId
  if (!leadSid) return null
  const sessionsDir = resolveSessionsDir(ctx.env)
  return {
    store: new SubagentStore(leadSid, { dir: sessionsDir }),
    probeDeps: realProbeDeps(),
    emit: (channel, payload) => ctx.emit?.(channel, payload),
    kill: (pid) => {
      try {
        process.kill(pid)
      } catch {
        // already gone
      }
    },
    sessionsDir,
    leadSid,
    now: () => new Date(),
    tick: ctx.tick,
    ansi: true,
    tokenBudget: resolveTokenBudget(ctx.env),
    // Publish presence unless opted out. Best-effort agent-mesh.
    ...(ctx.env.MINIMAL_AGENT_SUBAGENT_NO_PRESENCE === "1"
      ? {}
      : {
          presenceDir: presenceDir(ctx.env),
          leadPid: ctx.agent?.pid ?? process.pid,
          ...(ctx.agent?.model ? { leadModel: ctx.agent.model } : {}),
          leadCwd: ctx.cwd,
        }),
  }
}
