/**
 * Pure spawn-plan builder (Strategy: isolation tier `fresh` | `fork`).
 *
 * Turns a validated spawn request into a {@link SpawnPlan}: the argv to launch
 * a headless `minimal-agent` child, the cwd, the env (carrying lineage +
 * depth so the child can self-enforce the nesting ban), the composed prompt,
 * and an optional `fork` pre-step. NO process is spawned here and no file is
 * touched: the imperative shell (`spawn.ts`) executes the plan. This keeps the
 * interesting logic unit-testable without launching anything.
 *
 * @module sub-agents/lib/spawn-plan
 */

import { ENV_LEAD_PID } from "./lead-watch.ts"
import { err, type Isolation, ok, type Result, type SessionId, type SubagentId } from "./types.ts"

/** Env keys the plan stamps so a child knows its lineage + depth. */
export const ENV_DEPTH = "MINIMAL_AGENT_SUBAGENT_DEPTH"
export const ENV_LEAD = "MINIMAL_AGENT_SUBAGENT_LEAD"
export const ENV_ID = "MINIMAL_AGENT_SUBAGENT_ID"
/**
 * The lead's OS pid. The worker's lead watch (`lead-watch.ts`) polls it and
 * exits when the lead is gone, also after a SIGKILL that ran no lead cleanup.
 */
export { ENV_LEAD_PID }

/**
 * The plugin-disable env var the agent boot consumes. Used only as the
 * fallback channel when no `--startup-profile` is passed (SPEC R11 off, or an
 * older core): then the plan sets it to the lead's value plus the worker-only
 * set, exactly as before. With a profile the child ignores this env, so the
 * plan leaves it alone.
 */
export const ENV_DISABLE_PLUGINS = "MINIMAL_AGENT_DISABLE_PLUGINS"

/** Hidden CLI flag that hands the lead's startup profile to a child (SPEC 4.3). */
export const STARTUP_PROFILE_FLAG = "--startup-profile"

/**
 * Plugins force-disabled for EVERY worker, regardless of role. `intercom` is a
 * peer-to-peer mesh between top-level human-driven sessions; a worker is an
 * internal leaf of one such session and must not appear on the roster or be
 * able to message real peers. (A drifting worker broadcasting to other people's
 * sessions is exactly the failure this prevents.) Sub-agents coordinate through
 * the in-fleet `SubAgentsMailbox`, never intercom.
 */
export const SUBAGENT_DISABLED_PLUGINS: readonly string[] = ["intercom"]

/** A validated request to launch one worker. */
export interface SpawnInput {
  /** How to invoke the agent, e.g. `["minimal-agent"]` or `["bun","run","…/src/index.ts"]`. Injected, never hardcoded. */
  readonly agentBin: readonly string[]
  /** The child's pinned session id (so the supervisor can find its files). */
  readonly childSid: SessionId
  /** The lead session that is spawning this worker. */
  readonly leadSid: SessionId
  /**
   * The lead's OS pid, stamped as {@link ENV_LEAD_PID} for the worker's lead
   * watch. Default `process.pid` (the lead process builds the plan).
   */
  readonly leadPid?: number
  /** Short handle id (`"A2"`) — stamped into the child env for its own self-id. */
  readonly id: SubagentId
  /** The delegation prompt (objective + boundaries). */
  readonly task: string
  /**
   * Resolved model id the child runs. May be `""` (empty): the plugin is
   * model-agnostic, so when no model is known the flag is omitted and the child
   * self-resolves its own default. Never a hardcoded vendor SKU.
   */
  readonly model: string
  /**
   * Resolved provider id for the model, e.g. `"opencode"`. When set alongside a
   * non-empty model, the spawn passes `--provider` so the child can resolve the
   * model without re-deriving the provider from its own registry. Optional: when
   * omitted and `model` is set, the child MUST have the provider configured
   * independently (config, env), or boot will fail with "model requires an
   * explicit provider".
   */
  readonly provider?: string
  /** Optional reasoning effort. */
  readonly effort?: string
  /**
   * Named auth credential the child must use (the lead's `--credential-name`).
   * Multi-account providers (e.g. two ChatGPT OAuth entries) resolve by display
   * name; without this flag a worker falls back to the provider default and can
   * hit a different account than the lead (Brittany/Nathan: lead on
   * `openai-chatgpt-oauth-2`, workers on the first `OpenAI ChatGPT (OAuth)` entry
   * → Codex 400 "gpt-5.6-sol not supported").
   */
  readonly credentialName?: string
  /**
   * When true, the plan clears inherited `MINIMAL_AGENT_EFFORT` in the child env
   * so a lead's published effort (see core `publishResolvedRequestEnv`) cannot
   * leak into a worker that intentionally has no `--effort`. Without this, a
   * lead on `xhigh` (OpenAI) spawns a grok/OpenCode child that dies at boot:
   * `effort "xhigh" is not supported by this model (supported: medium, high, max)`.
   * Default true when `effort` is unset; callers may force it.
   */
  readonly scrubInheritedEffort?: boolean
  /** Writable mode for the child. Non-interactive defaults to read-only ASK, so workers that edit need `"none"` (or another writable mode). */
  readonly mode: string
  /** Context isolation tier. */
  readonly isolation: Isolation
  /** Specialization preamble (the worker definition body), folded into the prompt. */
  readonly systemPreamble?: string
  /**
   * The REQUIRED deliverable-protocol text, ALREADY RENDERED from its markdown
   * template (see `lib/prompts.ts`), appended last so the worker knows how to
   * finish: write any required file itself, then call `ReportResult`. When set,
   * the same sentinel path is also passed via `extraEnv` as
   * `MINIMAL_AGENT_SUBAGENT_RESULT_PATH` so the `ReportResult` handler (and the
   * documented manual fallback) know where to write.
   */
  readonly resultProtocol?: string
  /** This child's nesting depth (lead = 0 → its workers = 1). */
  readonly depth: number
  /** Working directory the child runs in. */
  readonly cwd: string
  /** Extra env to merge (e.g. tool allow/deny markers a future gate reads). */
  readonly extraEnv?: Record<string, string>
  /**
   * Path of the startup profile the child boots with (SPEC 4.4). Emitted as
   * `--startup-profile <path>` for both isolation tiers (SPEC 4.6), unless
   * {@link SpawnInput.inherit} is false. The lead's plugin disables (SPEC R4)
   * ride inside the profile. Omit when the host exposes no profile (SPEC T8).
   */
  readonly startupProfilePath?: string
  /**
   * SPEC R11 switch. False (env `MINIMAL_AGENT_SUBAGENT_INHERIT=0`) drops
   * `--startup-profile`. The tool and mode clamps still apply. Default true.
   */
  readonly inherit?: boolean
  /**
   * The lead's own `MINIMAL_AGENT_DISABLE_PLUGINS` value (raw, comma-separated).
   * Read ONLY when no `--startup-profile` is emitted: the plan then unions it
   * with {@link SUBAGENT_DISABLED_PLUGINS} into the env overlay (old
   * behavior). With a profile, the lead's disables come from the profile
   * (SPEC R4) and this field is ignored.
   */
  readonly inheritedDisabledPlugins?: string
  /**
   * The clamped worker tool allow-list (SPEC R6, R9), from `clampTools`. When
   * set and non-empty, the plan emits `--tools <a,b,...>`. Undefined or empty
   * emits nothing (the child sees all tools). The plan never emits
   * `--no-tools`, because deny-all also blocks `ReportResult`.
   */
  readonly toolArgs?: readonly string[]
}

/** The result of {@link buildSpawnPlan}: everything the shell needs to launch a worker. */
export interface SpawnPlan {
  /** Full argv (executable first). */
  readonly argv: readonly string[]
  /** Directory to run the child in. */
  readonly cwd: string
  /** Env overlay to apply on top of `process.env`. */
  readonly env: Record<string, string>
  /** The composed prompt the child receives (preamble + task). */
  readonly prompt: string
}

/**
 * Compose the child prompt. Layering, top to bottom:
 *   1. the specialization preamble (the worker reads its role first),
 *   2. the concrete task,
 *   3. the REQUIRED result protocol (when supplied).
 *
 * Pure: the `resultProtocol` text is passed in ALREADY RENDERED from its
 * markdown template (see `lib/prompts.ts`), so this module reads no files and
 * holds no prose. The protocol tells the worker how to finish: write any
 * required file itself, then call `ReportResult` to hand the work back (the
 * handler writes the sentinel deterministically). A dedicated
 * `--append-system-prompt` flag would be cleaner; this works today without a
 * core change.
 */
export function composePrompt(
  task: string,
  systemPreamble?: string,
  resultProtocol?: string,
): string {
  const t = task.trim()
  const p = systemPreamble?.trim()
  const base = p ? `${p}\n\n---\n\nYour task:\n\n${t}` : t
  const rp = resultProtocol?.trim()
  if (!rp) return base
  return `${base}\n\n---\n\n${rp}`
}

/**
 * Build a launch plan. Pure. Returns a {@link Result} so callers handle
 * invalid input as a value, not a thrown exception.
 */
export function buildSpawnPlan(input: SpawnInput): Result<SpawnPlan> {
  if (input.agentBin.length === 0) return err("agentBin is empty")
  if (input.task.trim().length === 0) return err("task is empty")
  // NOTE: an empty `model` is intentionally VALID. The sub-agents plugin is
  // model-agnostic and may not know a model id at spawn time (no env override,
  // no live lead model). In that case we OMIT `--model` below so the spawned
  // child self-resolves through its own `userConfig.model ?? DEFAULT_MODEL`,
  // exactly as the lead did. We never substitute a hardcoded vendor SKU here.
  if (!Number.isInteger(input.depth) || input.depth < 1) {
    return err(`depth must be a positive integer, got ${input.depth}`)
  }

  const prompt = composePrompt(input.task, input.systemPreamble, input.resultProtocol)

  const flags: string[] = []
  // `fork`: resume the LEAD's session so its history forks into the child's
  // pinned sid (the agent's resume path forks srcSid → getSessionId(), and
  // `--session-id` pins getSessionId() to the child). This inherits the lead's
  // context AND shares its prompt cache, with no extra core machinery. `fresh`
  // opens a brand-new session with only the task. Both pin `--session-id` so
  // the supervisor knows the sid up front.
  if (input.isolation === "fork") {
    flags.push("--resume", input.leadSid)
  }
  flags.push("--session-id", input.childSid, "--no-header", "--mode", input.mode)
  // stream-json: stdout becomes a typed JSONL event protocol (session_started …
  // run_finished, result) that the supervisor reads for live telemetry and a
  // definite end of run. It also puts the child in protocol stdio mode, so no
  // markdown formatter is spawned and no human chrome is written.
  flags.push("--output-format", "stream-json")
  // Omit `--model` when empty: the child self-resolves its own default model.
  // This keeps the plugin model-agnostic (see the empty-model note above).
  // When model IS set, also pass `--provider` if we know it, so the child can
  // resolve the model without re-deriving the provider from its own registry.
  if (input.model.trim().length > 0) {
    flags.push("--model", input.model.trim())
    if (input.provider && input.provider.trim().length > 0) {
      flags.push("--provider", input.provider.trim())
    }
  }
  const effort = input.effort?.trim() ?? ""
  if (effort.length > 0) {
    flags.push("--effort", effort)
  }
  const credentialName = input.credentialName?.trim() ?? ""
  if (credentialName.length > 0) {
    flags.push("--credential-name", credentialName)
  }
  const tools = (input.toolArgs ?? []).map((t) => t.trim()).filter((t) => t.length > 0)
  if (tools.length > 0) {
    flags.push("--tools", tools.join(","))
  }
  const profilePath = input.startupProfilePath?.trim() ?? ""
  const withProfile = input.inherit !== false && profilePath.length > 0
  if (withProfile) {
    flags.push(STARTUP_PROFILE_FLAG, profilePath)
  }
  // Worker-only disables at the CLI tier: they win over the profile (SPEC 5).
  for (const id of SUBAGENT_DISABLED_PLUGINS) flags.push("--disable-plugin", id)
  // `--prompt` last so the text can't be mistaken for a flag value.
  flags.push("--prompt", prompt)

  // Env overlay. The launcher merges this OVER process.env, so empty-string
  // values here blank keys the lead published (MINIMAL_AGENT_EFFORT etc.) that
  // would otherwise win on the child when we intentionally omit the matching
  // CLI flag. Core `resolveEffort` treats empty as unset.
  const scrubEffort =
    input.scrubInheritedEffort === true ||
    (input.scrubInheritedEffort !== false && effort.length === 0)
  const env: Record<string, string> = {
    [ENV_DEPTH]: String(input.depth),
    [ENV_LEAD]: input.leadSid,
    [ENV_ID]: input.id,
    ...input.extraEnv,
    // No profile: keep the old env channel (lead disables + worker-only set).
    // Spread after extraEnv so an extraEnv entry cannot clobber it.
    ...(withProfile
      ? {}
      : { [ENV_DISABLE_PLUGINS]: mergeDisabledPlugins(input.inheritedDisabledPlugins) }),
    // The lead's pid for the worker's lead watch. Spread after extraEnv so a
    // caller cannot point the watch at a wrong process.
    [ENV_LEAD_PID]: String(input.leadPid ?? process.pid),
    // Pin model/provider env to the plan so a lead's MINIMAL_AGENT_MODEL /
    // MINIMAL_AGENT_PROVIDER cannot outrank the worker's flags on any reader
    // that prefers env over argv (or when --model is omitted).
    ...(input.model.trim().length > 0
      ? { MINIMAL_AGENT_MODEL: input.model.trim() }
      : { MINIMAL_AGENT_MODEL: "" }),
    ...(input.provider && input.provider.trim().length > 0
      ? { MINIMAL_AGENT_PROVIDER: input.provider.trim() }
      : { MINIMAL_AGENT_PROVIDER: "" }),
    ...(effort.length > 0
      ? { MINIMAL_AGENT_EFFORT: effort }
      : scrubEffort
        ? { MINIMAL_AGENT_EFFORT: "" }
        : {}),
  }

  return ok({
    argv: [...input.agentBin, ...flags],
    cwd: input.cwd,
    env,
    prompt,
  })
}

/**
 * Union an inherited comma-separated `MINIMAL_AGENT_DISABLE_PLUGINS` value with
 * {@link SUBAGENT_DISABLED_PLUGINS}, deduped and order-stable (inherited ids
 * first, then the worker-only ids). Pure. The result always contains the
 * worker-only set. Used only on the no-profile path.
 */
export function mergeDisabledPlugins(inherited?: string): string {
  const ids: string[] = []
  const seen = new Set<string>()
  const add = (raw: string): void => {
    const id = raw.trim()
    if (id.length === 0 || seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  if (inherited) for (const part of inherited.split(",")) add(part)
  for (const id of SUBAGENT_DISABLED_PLUGINS) add(id)
  return ids.join(",")
}
