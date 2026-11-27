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

import { inheritEnabled } from "./inherit-summary.ts"
import { resolveDefinition } from "./library.ts"
import { presenceDir } from "./presence.ts"
import { type PromptRender } from "./prompts.ts"
import {
  resolveAgentBin,
  resolveAutoTier,
  resolveCredentialName,
  resolveDepth,
  resolveLeadEffort,
  resolveModelOverride,
  resolvePolicy,
  resolveSessionsDir,
  resolveTokenBudget,
} from "./runtime.ts"
import { type ServiceDeps } from "./service.ts"
import {
  isTrackedExited,
  type ProbeDeps,
  realProbeDeps,
  realSpawnDeps,
  waitExitOrKill,
} from "./spawn.ts"
import { ENV_LEAD } from "./spawn-plan.ts"
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
 * The lead's credential name and effort for a new worker.
 *
 * With `ctx.queryTarget` (a host that gives the live target), the values are
 * the lead's target AT THIS SPAWN, so a worker that starts after the user
 * switched the credential or the effort gets the new ones. An absent value
 * there is real (the provider default credential, the model default
 * effort): it never falls back to a stale boot value.
 *
 * With no `queryTarget` (an older core, or a host with more sessions in one
 * process), the old sources apply: the env, then the lead's own argv.
 */
export function resolveLeadCredentialAndEffort(
  ctx: Pick<TUIContext, "queryTarget" | "env">,
  argv: readonly string[] = process.argv,
): { credentialName: string; effort: string } {
  const live = ctx.queryTarget?.()
  if (live) {
    return { credentialName: live.credentialName?.trim() ?? "", effort: live.effort?.trim() ?? "" }
  }
  return {
    credentialName: resolveCredentialName(ctx.env, argv),
    effort: resolveLeadEffort(ctx.env, argv),
  }
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
  // The live target first: it is the provider the lead sends to now.
  return ctx.queryTarget?.()?.providerId?.trim() || ctx.queryModelInfo?.()?.providerId?.trim() || ""
}

/**
 * Build `resolveProvider` for the service layer.
 *
 * When the worker reuses the LEAD's LIVE model id, pin the lead's live
 * provider so dual-registered bare ids stay on the gateway the user selected.
 * Comparison is against the live snapshot model id (not `defaultModel`), so an
 * env model override to a *different* SKU does not inherit the lead provider.
 * For any other model id (per-spawn override, role recommendation, env
 * override that differs from the live model), first ask the host whether the
 * LEAD's provider serves that id (`models.findForProvider`). If yes, keep the
 * worker on the lead provider, so it also inherits the lead's credential. A
 * bare model id does not identify a provider: `claude-haiku-4-5` is registered
 * by anthropic, opencode-zen and cursor, and the unscoped last-write-wins
 * `models.find` picked opencode-zen with an expired key (A1 bug, 401). Only
 * when the lead provider does not serve the id do we fall back to `find`.
 */
/**
 * True when `providerId` registered `modelId` (as id or alias). Uses the
 * host's scoped `findForProvider` when present. Older pinned cores lack it,
 * so fall back to scanning `models.list()`.
 */
function leadProviderServes(ctx: TUIContext, modelId: string, providerId: string): boolean {
  const models = ctx.host?.models
  if (!models) return false
  if (models.findForProvider) return Boolean(models.findForProvider(modelId, providerId))
  const entries = models.list?.() ?? []
  return entries.some(
    (e) =>
      e.providerId === providerId && (e.id === modelId || (e.aliases?.includes(modelId) ?? false)),
  )
}

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
    // Prefer the lead provider when it serves this model id.
    if (leadProvider && leadProviderServes(ctx, id, leadProvider)) return leadProvider
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
  const leadProvider = resolveLeadProvider(ctx)
  const models = ctx.host?.models
  const hasRegistry = Boolean(models?.find || models?.findForProvider)
  // Wire when we have ANY live levels array (including empty = no-effort model)
  // or a registry to consult. Only skip when both are absent.
  if (liveLevels === undefined && !hasRegistry) return undefined

  return (modelId: string): readonly string[] | undefined => {
    const id = modelId.trim()
    if (id.length === 0) return undefined
    // Live snapshot for the lead model: keep empty `[]` (known: no effort
    // support). Collapsing `[]` → `undefined` made spawn treat no-effort
    // models as "unknown → pass effort through" and children died at boot
    // (Thomas/Adrian: effort "medium" on cursor-grok).
    if (liveModelId && id === liveModelId && liveLevels) {
      return liveLevels
    }
    const entry = (
      leadProvider && models?.findForProvider
        ? (models.findForProvider(id, leadProvider) ?? models.find?.(id))
        : models?.find?.(id)
    ) as { capabilities?: { effort?: { levels?: readonly string[] } } } | undefined
    if (!entry) return undefined
    const levels = entry.capabilities?.effort?.levels
    // Registry hit: missing/empty levels → known no support (`[]`), not unknown.
    return levels ?? []
  }
}

/** Bind `ctx.prompts.render`. Throws on use when the host wired no prompt provider. */
function promptRenderFromCtx(ctx: TUIContext): PromptRender {
  const prompts = ctx.prompts
  return (name, vars) => {
    if (!prompts) throw new Error("sub-agents: ctx.prompts is not available")
    return prompts.render(name, vars)
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
  const renderPrompt = promptRenderFromCtx(ctx)
  // Lead identity for child spawn: credential + effort + provider. Argv is the
  // lead process's own process.argv (workers re-invoke via resolveAgentBin).
  const leadProvider = resolveLeadProvider(ctx)
  const { credentialName: defaultCredentialName, effort: defaultEffort } =
    resolveLeadCredentialAndEffort(ctx)
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
    renderPrompt,
    resolveDefinition: (name) => resolveDefinition(name, renderPrompt),
    ...(recommendForRole ? { recommendForRole } : {}),
    ...(resolveProvider ? { resolveProvider } : {}),
    ...(effortLevelsForModel ? { effortLevelsForModel } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(defaultCredentialName ? { defaultCredentialName } : {}),
    ...(leadProvider ? { leadProvider } : {}),
    policy: resolvePolicy(ctx.env),
    // Pass the lead's own plugin-disable list through so the spawn plan unions
    // it with the worker-only disables (intercom) rather than dropping it.
    ...(ctx.env.MINIMAL_AGENT_DISABLE_PLUGINS
      ? { disabledPlugins: ctx.env.MINIMAL_AGENT_DISABLE_PLUGINS }
      : {}),
    ...(ctx.emitChain ? { emitChain: ctx.emitChain.bind(ctx) } : {}),
    // Live lead mode + tool policy for the permission clamp (SPEC R6, R7).
    // Older cores lack the member: the service falls back to the env mode (SPEC T8).
    ...(ctx.queryHostPolicy ? { queryHostPolicy: () => ctx.queryHostPolicy?.() } : {}),
    // Fallback lead mode for the clamp when the host has no policy snapshot.
    ...(ctx.env.MINIMAL_AGENT_MODE ? { leadModeEnv: ctx.env.MINIMAL_AGENT_MODE } : {}),
    // The lead startup profile (SPEC 4.5). Older cores lack it (SPEC T8).
    ...(ctx.startupProfile ? { startupProfile: () => ctx.startupProfile?.() } : {}),
    // SPEC R11: "0" drops --startup-profile only. The clamps still apply.
    inherit: inheritEnabled(ctx.env),
    warn: (msg: string) => ctx.log.warn(msg),
  }
}

/** A store bound to the lead session (for read-only handlers), or `null`. */
export function storeFromCtx(ctx: TUIContext): SubagentStore | null {
  const leadSid = ctx.env[ENV_LEAD]?.trim() || ctx.agent?.sessionId
  if (!leadSid) return null
  return new SubagentStore(leadSid, { dir: resolveSessionsDir(ctx.env) })
}

/** The sessions dir for a tool handler (where child `.log` / `.result.json` live). */
export function sessionsDirFromCtx(ctx: TUIContext): string {
  return resolveSessionsDir(ctx.env)
}

const probeDepsCache = new Map<string, ProbeDeps>()

function cachedProbeDepsFor(sessionsDir: string, leadSid: string): ProbeDeps {
  const key = `${sessionsDir}\0${leadSid}`
  let deps = probeDepsCache.get(key)
  if (!deps) {
    deps = realProbeDeps()
    probeDepsCache.set(key, deps)
  }
  return deps
}

/** Drop cached incremental stream/progress readers for a lead (or all leads). */
export function clearProbeDepsCache(leadSid?: string): void {
  if (!leadSid) {
    probeDepsCache.clear()
    return
  }
  const suffix = `\0${leadSid}`
  for (const key of probeDepsCache.keys()) {
    if (key.endsWith(suffix)) probeDepsCache.delete(key)
  }
}

/** Build {@link SupervisorDeps} for the heartbeat slot, or `null` when no session id. */
export function supervisorDepsFromCtx(ctx: LiveAreaHandlerContext): SupervisorDeps | null {
  const leadSid = ctx.agent?.sessionId
  if (!leadSid) return null
  const sessionsDir = resolveSessionsDir(ctx.env)
  return {
    store: new SubagentStore(leadSid, { dir: sessionsDir }),
    probeDeps: cachedProbeDepsFor(sessionsDir, leadSid),
    emit: (channel, payload) => ctx.emit?.(channel, payload),
    // SIGKILL (not SIGTERM): a worker that has used Fetch may have installed
    // signal listeners that swallow SIGTERM. SIGKILL always reaps the bun
    // process; its detached obscura-worker then exits on stdin EOF.
    kill: (pid) => {
      if (isTrackedExited(pid)) return
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // already gone
      }
    },
    stopAfterFlush: (pid, delayMs) => {
      void waitExitOrKill(pid, delayMs)
    },
    // SIGTERM at a limit: the worker runs one final turn that calls
    // ReportResult, then exits. The SIGKILL above is the fallback at the grace
    // end (DEFAULT_GRACE_SEC), because the worker can swallow SIGTERM.
    terminate: (pid) => {
      try {
        process.kill(pid, "SIGTERM")
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
