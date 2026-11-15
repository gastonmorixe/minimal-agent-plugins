/**
 * The ACP `hostModes[].entry` handler: `initialize`, `session/new`,
 * `session/prompt`, `session/cancel`, `session/set_config_option`. Level 1
 * scope (ACP spec section 12 Phase 1) — no fs, no terminal.
 * Builds on `transport.ts` (this plugin's own hand-rolled JSON-RPC). The
 * `session/update` encoding lives in `encoder.ts` (on top of core's shared
 * wire-event mapper, `@minimal-agent/core/sdk/events`), the stop-reason
 * refinement in `stop-reason.ts`, notices in `notices.ts`, and model /
 * effort config options in `config-options.ts`. This file only wires them.
 *
 * ONE session per process (Level 1 / `acp-decisions.md` item 10):
 * `session/new` succeeds exactly once; a second call is a JSON-RPC error.
 *
 * Approval gate (`permission.ts`): OFF by default. `--approval` after
 * `--host-mode acp` turns it on. Then every tool call sends
 * `session/request_permission`, and any failure denies only that call.
 * If core did not load the gate hook (a broken import, or no grant), no
 * tool call can be asked about. Then `session/new` writes a warning to
 * stderr, and every `session/prompt` fails with a JSON-RPC error before
 * the model runs, so no tool runs without approval. The process and the
 * session stay open. `--approval-timeout-ms <n>` sets the gate deadline
 * (default 10 min). A bad value is a startup error: the handler writes it
 * to stderr and returns exit code 2 before it reads stdin.
 *
 * `session/set_config_option` answers with the complete option list and
 * sends no `config_option_update`. ACP keeps that update for changes the
 * agent makes itself (`model_adopted`). A set to the current value changes
 * nothing.
 *
 * `session/new` accepts ACP unstable `systemPrompt {mode, content}` (append
 * and override, text blocks only) and passes it to `openSession(options)`.
 *
 * Advertise only what the runtime can apply (contract section 4 rule 7).
 * The CLI gives `ctx.runtime.capabilities` (see {@link RuntimeCapabilities}).
 * No object (an older CLI): every flag is false. Then `initialize` has no
 * `sessionCapabilities.systemPrompt`, the ext features are `["usage"]`, and
 * a `session/new` with `systemPrompt` is -32602, so the client never
 * thinks the instructions were applied.
 *
 * L3 per-turn options (`docs/acp-extensions.md` 5.e, 5.f), read from
 * `session/prompt` `_meta` only when the feature is effective:
 * `minimal-agent/outputSchema` (feature `structuredOutput`) is passed to
 * `run` as `outputSchema`. The final text is parsed and checked
 * (`structured-output.ts`), with up to 2 corrective retries in the same
 * turn. The reply has `_meta["minimal-agent/output"]` or
 * `_meta["minimal-agent/outputError"]`, never a wire error.
 * `minimal-agent/sampling {temperature}` (feature `sampling`) is passed as
 * `temperature`. A core `agent.temperature-ignored` diag entry gives one
 * notice per turn.
 *
 * Deferred: `session/load` / `session/list` / plan / image input.
 *
 * @module host-mode
 */

import { realpathSync } from "node:fs"
import { resolve } from "node:path"

import type {
  HostModeContext,
  HostModeHandler,
  HostSession,
} from "@minimal-agent/core/host-kit/host-mode"

import { buildConfigOptions, setConfigOption } from "./config-options.ts"
import { createSessionEncoder, type SessionEncoder, type SessionEncoderOptions } from "./encoder.ts"
import { errorText } from "./error-text.ts"
import {
  EXT_CAPABILITY_KEY,
  EXT_NAMESPACE,
  type ExtAdvert,
  effectiveFeatures,
  hasExtFeature,
  localExt,
  NO_EXT,
  readPeerExt,
} from "./ext.ts"
import { clientSupportsNotices, noticeUpdate } from "./notices.ts"
import {
  createPermissionGate,
  type HostModeArgs,
  HostModeArgsError,
  hookRegistered,
  type PermissionGate,
  parseHostModeArgs,
  setActiveGate,
} from "./permission.ts"
import {
  checkStructuredOutput,
  decideStructuredStep,
  OUTPUT_ERROR_META_KEY,
} from "./structured-output.ts"
import { createRpcChannel, RPC_ERROR, RpcError } from "./transport.ts"

/** The error text when `--approval` is on but core did not load the gate hook. */
export const GATE_NOT_LOADED =
  "the ACP approval gate failed to load (core skipped the tool.willInvoke hook: see the plugin load log on stderr). --approval is on, so no turn runs: no tool call can be approved"

/** How long the gate waits for the `tool_call` update before it sends the request anyway. */
const TOOL_CALL_SENT_WAIT_MS = 1000

interface ContentBlock {
  readonly type: string
  readonly text?: string
  readonly uri?: string
}

/** Level 1: flatten `text` and `resource_link` blocks to one string. Anything else is -32602. */
function flattenPrompt(blocks: unknown): string {
  if (!Array.isArray(blocks)) throw new RpcError(RPC_ERROR.invalidParams, "prompt must be an array")
  const parts: string[] = []
  for (const raw of blocks as unknown[]) {
    const b = raw as ContentBlock
    if (b?.type === "text" && typeof b.text === "string") {
      parts.push(b.text)
    } else if (b?.type === "resource_link" && typeof b.uri === "string") {
      parts.push(`[resource: ${b.uri}]`)
    } else {
      throw new RpcError(
        RPC_ERROR.invalidParams,
        `unsupported prompt block type "${b?.type ?? "undefined"}" (Level 1 accepts text and resource_link only)`,
      )
    }
  }
  return parts.join("")
}

/**
 * The `systemPrompt` option core's `HostRuntime.openSession(options)` takes
 * (core `src/host-public/host-mode.ts`, `HostSystemPromptOption`). Typed
 * here as a narrow structural type: the pinned core in this repo's
 * `node_modules` has `openSession()` with no options, a local core has
 * `openSession(options?)`. This type compiles against both. A core that
 * ignores the argument opens the session with no system prompt option.
 */
interface SystemPromptOption {
  readonly mode: "append" | "override"
  readonly text: string
}
type OpenSessionWithOptions = (options?: {
  readonly systemPrompt?: SystemPromptOption
}) => Promise<HostSession>

/**
 * Read `session/new` `systemPrompt {mode, content}` (ACP unstable,
 * `SystemPrompt`). Absent or `null`: no option. `mode` must be `append` or
 * `override`. `content` must be an array of `text` blocks, joined with a
 * blank line. Any other block type is -32602 (`promptCapabilities.image` is
 * false). Text that is empty after trim gives no option.
 */
function readSystemPrompt(params: Record<string, unknown>): SystemPromptOption | undefined {
  const raw = params.systemPrompt
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RpcError(RPC_ERROR.invalidParams, "session/new: systemPrompt must be an object")
  }
  const { mode, content } = raw as { mode?: unknown; content?: unknown }
  if (mode !== "append" && mode !== "override") {
    throw new RpcError(
      RPC_ERROR.invalidParams,
      `session/new: unsupported systemPrompt mode ${JSON.stringify(mode)} (supported: "append", "override")`,
    )
  }
  if (!Array.isArray(content)) {
    throw new RpcError(
      RPC_ERROR.invalidParams,
      "session/new: systemPrompt.content must be an array",
    )
  }
  const parts: string[] = []
  for (const block of content as unknown[]) {
    const b = block as ContentBlock | null
    if (b?.type !== "text" || typeof b.text !== "string") {
      throw new RpcError(
        RPC_ERROR.invalidParams,
        `session/new: unsupported systemPrompt content block type "${b?.type ?? "undefined"}" (only text is accepted)`,
      )
    }
    parts.push(b.text)
  }
  const text = parts.join("\n\n")
  return text.trim() === "" ? undefined : { mode, text }
}

/**
 * What the CLI's core can really apply, from `ctx.runtime.capabilities`
 * (CLI `src/startup/run-host-mode.ts`, `HostRuntimeCapabilities`). A narrow
 * structural type: core's `HostRuntime` does not declare it.
 */
export interface RuntimeCapabilities {
  readonly systemPrompt: { readonly append: boolean; readonly override: boolean }
  readonly outputSchema: boolean
  readonly temperature: boolean
}

/** Every flag false: the value for a runtime with no (or a bad) `capabilities` object. */
const NO_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  systemPrompt: Object.freeze({ append: false, override: false }),
  outputSchema: false,
  temperature: false,
})

/** Read `runtime.capabilities`. A missing object or a non-`true` flag is false. Never throws. */
export function readRuntimeCapabilities(runtime: unknown): RuntimeCapabilities {
  if (typeof runtime !== "object" || runtime === null) return NO_CAPABILITIES
  const raw = (runtime as { capabilities?: unknown }).capabilities
  if (typeof raw !== "object" || raw === null) return NO_CAPABILITIES
  const c = raw as { systemPrompt?: unknown; outputSchema?: unknown; temperature?: unknown }
  const sp =
    typeof c.systemPrompt === "object" && c.systemPrompt !== null
      ? (c.systemPrompt as { append?: unknown; override?: unknown })
      : {}
  return {
    systemPrompt: { append: sp.append === true, override: sp.override === true },
    outputSchema: c.outputSchema === true,
    temperature: c.temperature === true,
  }
}

/** True when the runtime can apply the L3 `feature` (contract section 5). */
function runtimeSupportsFeature(caps: RuntimeCapabilities, feature: string): boolean {
  if (feature === "structuredOutput") return caps.outputSchema
  if (feature === "sampling") return caps.temperature
  return true
}

/** True when `initialize` advertised `mode` (append needs `append`, override needs both). */
function systemPromptSupported(caps: RuntimeCapabilities, mode: "append" | "override"): boolean {
  if (!caps.systemPrompt.append) return false
  return mode === "append" || caps.systemPrompt.override
}

/** `session/prompt` `_meta` key for the output schema (contract 5.e). */
export const OUTPUT_SCHEMA_META_KEY = `${EXT_NAMESPACE}/outputSchema`
/** `session/prompt` `_meta` key for sampling options (contract 5.f). */
export const SAMPLING_META_KEY = `${EXT_NAMESPACE}/sampling`
/** The core diagnostic code when the model does not accept temperature (core patch D4). */
const TEMPERATURE_IGNORED_CODE = "agent.temperature-ignored"

/**
 * The per-run options core's `HostSession.run` takes after core patches D1
 * (`outputSchema`) and D4 (`temperature`). Typed here as a narrow
 * structural type, like {@link OpenSessionWithOptions}: the pinned core
 * types `run(input, {emitDeltas, signal})`. A core that does not know a
 * key ignores it (the CLI warns on stderr and runs without it).
 */
interface RunOptions {
  readonly emitDeltas: true
  readonly signal: AbortSignal
  readonly outputSchema?: object
  readonly temperature?: number
}
type RunWithOptions = (input: string, options: RunOptions) => ReturnType<HostSession["run"]>

/** The per-turn L3 options read from `session/prompt` `_meta`. */
interface PromptExtOptions {
  readonly outputSchema?: object
  readonly temperature?: number
}

/**
 * Read the L3 keys of `session/prompt` `_meta` that are in the effective
 * set. A key of a feature NOT in the effective set is ignored (contract
 * section 4 rule 4). A present key with a bad value is -32602.
 */
function readPromptExt(params: Record<string, unknown>, ext: ExtAdvert): PromptExtOptions {
  const meta = params._meta
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return {}
  const m = meta as Record<string, unknown>
  const out: { outputSchema?: object; temperature?: number } = {}
  if (hasExtFeature(ext, "structuredOutput") && m[OUTPUT_SCHEMA_META_KEY] !== undefined) {
    const schema = m[OUTPUT_SCHEMA_META_KEY]
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      throw new RpcError(
        RPC_ERROR.invalidParams,
        `session/prompt: _meta["${OUTPUT_SCHEMA_META_KEY}"] must be a JSON Schema object`,
      )
    }
    out.outputSchema = schema
  }
  if (hasExtFeature(ext, "sampling") && m[SAMPLING_META_KEY] !== undefined) {
    const sampling = m[SAMPLING_META_KEY]
    if (typeof sampling !== "object" || sampling === null || Array.isArray(sampling)) {
      throw new RpcError(
        RPC_ERROR.invalidParams,
        `session/prompt: _meta["${SAMPLING_META_KEY}"] must be an object`,
      )
    }
    const { temperature } = sampling as { temperature?: unknown }
    if (temperature !== undefined) {
      // No range check: the provider checks the range (contract 5.f).
      if (typeof temperature !== "number" || !Number.isFinite(temperature)) {
        throw new RpcError(
          RPC_ERROR.invalidParams,
          `session/prompt: _meta["${SAMPLING_META_KEY}"].temperature must be a finite number`,
        )
      }
      out.temperature = temperature
    }
  }
  return out
}

/** The params object of a request. Anything else is -32602 (never a TypeError, -32603). */
function paramsObject(raw: unknown, method: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RpcError(RPC_ERROR.invalidParams, `${method}: params must be an object`)
  }
  return raw as Record<string, unknown>
}

/** A string field of `params`, or `undefined` when absent. Other types are -32602. */
function optionalString(params: Record<string, unknown>, key: string, method: string) {
  const v = params[key]
  if (v !== undefined && typeof v !== "string") {
    throw new RpcError(RPC_ERROR.invalidParams, `${method}: ${key} must be a string`)
  }
  return v
}

/**
 * The real path of `dir`, so a symlink and its target compare equal (on
 * macOS, /var/folders/... is a symlink to /private/var/...). A path that
 * does not exist keeps its resolved form.
 */
function samePathKey(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return resolve(dir)
  }
}

const handler: HostModeHandler = async (ctx: HostModeContext): Promise<number> => {
  let session: HostSession | undefined
  let encoder: SessionEncoder | undefined
  let activeRun: AbortController | undefined
  // Stored at `initialize`: send `notice` updates only when the client
  // advertised `clientCapabilities.session.notices`.
  let clientNotices = false
  // Stored at `initialize`: the effective L3 extension set (`ext.ts`,
  // `docs/acp-extensions.md` section 2.3). Fixed for the connection.
  // Empty until `initialize`, and for a client with no valid advert.
  let ext: ExtAdvert = NO_EXT
  // Counts `session/prompt` turns, for unique notice fallback message ids.
  let turnSeq = 0
  let args: HostModeArgs
  try {
    args = parseHostModeArgs(ctx.argv)
  } catch (e) {
    if (!(e instanceof HostModeArgsError)) throw e
    ctx.stderr.write(`acp: error: ${e.message}\n`)
    return 2
  }
  if (args.unknown.length > 0)
    ctx.log.warn("acp", `ignored unknown args: ${args.unknown.join(" ")}`)
  if (args.approvalTimeoutSet && !args.approval)
    ctx.log.warn("acp", "--approval-timeout-ms has no effect without --approval")
  // What the runtime can apply. Read once: the CLI fixes it per process.
  const caps = readRuntimeCapabilities(ctx.runtime)
  const advertisedExt = localExt((f) => runtimeSupportsFeature(caps, f))
  // Set at `session/new` only when approval is on.
  let gate: PermissionGate | undefined
  // True when approval is on but core did not load the gate hook.
  let gateNotLoaded = false

  const requireSession = (sessionId: unknown): HostSession => {
    if (!session || session.sessionId !== sessionId) {
      throw new RpcError(RPC_ERROR.invalidParams, `unknown session: ${String(sessionId)}`)
    }
    return session
  }

  const channel = createRpcChannel({
    stdin: ctx.stdin,
    write: (line) => {
      ctx.stdout.write(line)
    },
    log: (msg) => ctx.log.debug("acp", msg),
    handlers: {
      requests: {
        initialize: (rawParams) => {
          clientNotices = clientSupportsNotices(rawParams)
          const clientCaps =
            typeof rawParams === "object" && rawParams !== null
              ? (rawParams as { clientCapabilities?: unknown }).clientCapabilities
              : undefined
          ext = effectiveFeatures(advertisedExt, readPeerExt(clientCaps))
          ctx.log.debug("acp", `ext: effective v${ext.version} [${ext.features.join(", ")}]`)
          const agentCapabilities: Record<string, unknown> = {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          }
          // ACP unstable: `systemPrompt` on `session/new`. `{}` means append,
          // `mode.override` adds override. ACP has no "override only" shape,
          // so no append support means no capability at all. Merge with
          // other session caps.
          if (caps.systemPrompt.append) {
            const sessionCaps = (agentCapabilities.sessionCapabilities ?? {}) as Record<
              string,
              unknown
            >
            agentCapabilities.sessionCapabilities = {
              ...sessionCaps,
              systemPrompt: caps.systemPrompt.override ? { mode: { override: {} } } : {},
            }
          }
          // Merge: keep any `_meta` key a later patch adds here.
          const meta = (agentCapabilities._meta ?? {}) as Record<string, unknown>
          agentCapabilities._meta = { ...meta, [EXT_CAPABILITY_KEY]: advertisedExt }
          return {
            protocolVersion: 1,
            agentCapabilities,
            agentInfo: { name: "minimal-agent", version: "0.1.0" },
            authMethods: [],
          }
        },
        "session/new": async (rawParams) => {
          if (session) {
            throw new RpcError(
              RPC_ERROR.invalidRequest,
              "a session is already open for this process (Level 1 is one session per process)",
            )
          }
          // `rawParams` is the raw JSON-RPC params (transport.ts parses with
          // JSON.parse, no schema), so `systemPrompt` is never stripped.
          const newParams = paramsObject(rawParams, "session/new")
          const cwd = optionalString(newParams, "cwd", "session/new")
          if (cwd !== undefined && cwd !== ctx.cwd && samePathKey(cwd) !== samePathKey(ctx.cwd)) {
            throw new RpcError(
              RPC_ERROR.invalidParams,
              `this process is fixed to cwd ${ctx.cwd}; a session with another cwd needs its own process`,
            )
          }
          const systemPrompt = readSystemPrompt(newParams)
          // Not advertised: reject, so the client never thinks it applied.
          if (systemPrompt && !systemPromptSupported(caps, systemPrompt.mode)) {
            throw new RpcError(
              RPC_ERROR.invalidParams,
              `session/new: systemPrompt mode "${systemPrompt.mode}" is not supported by this agent's runtime (not advertised in sessionCapabilities.systemPrompt); send the instructions in the prompt instead`,
            )
          }
          // See `OpenSessionWithOptions`: the pinned core types `openSession()`
          // with no options. Pass options only when a system prompt is set.
          const openSession = ctx.runtime.openSession.bind(ctx.runtime) as OpenSessionWithOptions
          const opened = await (systemPrompt ? openSession({ systemPrompt }) : openSession())
          session = opened
          // `ext` is the effective set from `initialize`. The encoder uses it
          // to gate `_meta["minimal-agent/usage"]`.
          const encoderOptions: SessionEncoderOptions = {
            send: (update) =>
              channel.notify("session/update", { sessionId: opened.sessionId, update }),
            clientNotices,
            runtime: ctx.runtime,
            cwd: ctx.cwd,
            ext,
          }
          encoder = createSessionEncoder(encoderOptions)
          if (args.approval && !hookRegistered()) {
            gateNotLoaded = true
            ctx.stderr.write(`acp: warning: ${GATE_NOT_LOADED}\n`)
          } else if (args.approval) {
            const enc = encoder
            gate = createPermissionGate({
              request: (method, params, signal) => channel.request(method, params, signal),
              sessionId: () => session?.sessionId,
              deadlineMs: args.approvalTimeoutMs,
              // Send the `tool_call` update before the request. A call inside
              // a worker (`agentId`) has no update in this stream: do not wait.
              beforeRequest: (payload) =>
                payload.agentId === undefined
                  ? enc.toolCallSent(payload.toolUseId, TOOL_CALL_SENT_WAIT_MS)
                  : Promise.resolve(),
              log: (msg) => ctx.log.debug("acp", msg),
            })
            setActiveGate(gate)
          }
          return { sessionId: opened.sessionId, configOptions: buildConfigOptions(ctx.runtime) }
        },
        "session/set_config_option": async (rawParams) => {
          const method = "session/set_config_option"
          const params = paramsObject(rawParams, method)
          requireSession(params.sessionId)
          const configId = optionalString(params, "configId", method)
          return { configOptions: await setConfigOption(ctx.runtime, configId, params.value) }
        },
        "session/prompt": async (rawParams) => {
          const params = paramsObject(rawParams, "session/prompt")
          const s = requireSession(params.sessionId)
          const input = flattenPrompt(params.prompt)
          const extOpts = readPromptExt(params, ext)

          const enc = encoder
          if (!enc) throw new RpcError(RPC_ERROR.internal, "session encoder missing")
          if (gateNotLoaded) throw new RpcError(RPC_ERROR.internal, GATE_NOT_LOADED)
          // Spec v3 Q2b: reject a second prompt while a turn runs, and leave
          // the running turn (and its encoder state) alone.
          if (activeRun) {
            throw new RpcError(
              RPC_ERROR.invalidParams,
              "a turn is already running for this session",
            )
          }
          const controller = new AbortController()
          activeRun = controller
          // A new turn: clear the deny-all state of an earlier session/cancel.
          gate?.startTurn()
          turnSeq += 1
          // See `RunWithOptions`: the pinned core types `run` with no D1/D4 keys.
          const runOnce = s.run.bind(s) as RunWithOptions
          const runOptions: RunOptions = {
            emitDeltas: true,
            signal: controller.signal,
            ...(extOpts.outputSchema ? { outputSchema: extOpts.outputSchema } : {}),
            ...(extOpts.temperature !== undefined ? { temperature: extOpts.temperature } : {}),
          }
          // Contract 5.f: one notice per turn when the model drops temperature.
          let temperatureNoticeSent = false
          try {
            let outcome: Parameters<SessionEncoder["finishTurn"]>[0]
            // Contract 5.e: the `_meta` keys of a structured turn.
            let structuredMeta: Record<string, unknown> = {}
            let runInput = input
            let retriesUsed = 0
            // Contract 5.e: the outcome of the first run, for a retry run
            // that ends failed (for example a blocking turn.willStart hook).
            let firstOutcome: typeof outcome | undefined
            for (;;) {
              // The final assistant text: `result.text` when core gives it,
              // else the text deltas of the last model round.
              let deltaId: string | undefined
              let deltaText = ""
              let resultText: string | undefined
              let runError: string | undefined
              // Contract 5.e: attempt 1 keeps core's messageId. Attempt n > 1
              // streams as `<id>-attempt-<n>`, so a client can tell them apart.
              const attempt = retriesUsed + 1
              try {
                const run = runOnce(runInput, runOptions)
                for await (const entry of run) {
                  if (entry.ch === "event") {
                    let ev = entry.data
                    if (
                      attempt > 1 &&
                      (ev.type === "text_delta" ||
                        ev.type === "thinking_delta" ||
                        ev.type === "retry-boundary")
                    ) {
                      ev = { ...ev, id: `${ev.id}-attempt-${attempt}` }
                    }
                    if (ev.type === "text_delta") {
                      if (ev.id !== deltaId) {
                        deltaId = ev.id
                        deltaText = ""
                      }
                      deltaText += ev.text
                    }
                    if (ev.type === "error") runError = ev.message
                    enc.encode(ev)
                  } else if (
                    entry.ch === "diag" &&
                    entry.data.code === TEMPERATURE_IGNORED_CODE &&
                    !temperatureNoticeSent
                  ) {
                    temperatureNoticeSent = true
                    channel.notify("session/update", {
                      sessionId: s.sessionId,
                      update: noticeUpdate(
                        {
                          severity: "warning",
                          title: "Temperature not applied",
                          description: `The model does not accept temperature. ${String(extOpts.temperature)} was not sent.`,
                        },
                        { clientNotices, fallbackMessageId: `notice-sampling-${turnSeq}` },
                      ),
                    })
                  }
                }
                const settled = await run.result
                const t = (settled as { text?: unknown }).text
                if (typeof t === "string") resultText = t
                // ACP: after session/cancel the reply is `cancelled`, also
                // when the run settles "completed" after the abort.
                outcome = controller.signal.aborted ? "aborted" : settled.outcome
              } catch (e) {
                // ACP: a cancel MUST answer `cancelled`, even when the cancel
                // made the run throw. Any other throw is a failed turn.
                if (!controller.signal.aborted) {
                  runError = errorText(e)
                  // A failed retry is reported as outputError (below), not
                  // as the turn error.
                  if (retriesUsed === 0) enc.encode({ type: "error", message: runError })
                }
                outcome = controller.signal.aborted ? "aborted" : "failed"
              }
              firstOutcome ??= outcome
              // Contract 5.e: a retry run that fails (or pauses) ends the turn
              // with the first run's stop reason plus outputError.
              if (
                extOpts.outputSchema &&
                retriesUsed > 0 &&
                (outcome === "failed" || outcome === "waiting")
              ) {
                structuredMeta = {
                  [OUTPUT_ERROR_META_KEY]: {
                    message: `retry ${retriesUsed} failed: ${runError ?? `the run ended ${outcome}`}`,
                  },
                }
                outcome = firstOutcome
                break
              }
              // A failed or cancelled turn has no final text to check.
              if (!extOpts.outputSchema || outcome === "failed" || outcome === "aborted") break
              let step: ReturnType<typeof decideStructuredStep>
              try {
                step = decideStructuredStep({
                  check: checkStructuredOutput(resultText ?? deltaText, extOpts.outputSchema),
                  retriesUsed,
                  outcome,
                })
              } catch (e) {
                // Never let the check throw out of the handler: finishTurn
                // must run so the next turn starts with clean encoder state.
                step = {
                  kind: "done",
                  meta: {
                    [OUTPUT_ERROR_META_KEY]: {
                      message: `the output check failed (${errorText(e)})`,
                    },
                  },
                }
              }
              if (step.kind === "done") {
                structuredMeta = step.meta
                break
              }
              // Retry in the same turn. The encoder keeps counting usage.
              retriesUsed += 1
              runInput = step.prompt
            }
            const reply = enc.finishTurn(outcome)
            if (reply.kind === "error") throw new RpcError(reply.code, reply.message)
            if (Object.keys(structuredMeta).length === 0) return reply.result
            const meta = (reply.result._meta ?? {}) as Record<string, unknown>
            return { ...reply.result, _meta: { ...meta, ...structuredMeta } }
          } finally {
            if (activeRun === controller) activeRun = undefined
          }
        },
      },
      notifications: {
        "session/cancel": (rawParams) => {
          const sessionId = (rawParams as { sessionId?: unknown } | null | undefined)?.sessionId
          if (session && sessionId === session.sessionId) {
            // ACP: a cancel also answers a waiting permission request. Deny it.
            gate?.cancelPending()
            activeRun?.abort()
          }
        },
      },
    },
  })

  // Shutdown (core's SIGTERM / SIGINT listeners abort `ctx.abort`): stop
  // reading, then finish the same way as at stdin EOF.
  const onAbort = (): void => channel.stop()
  if (ctx.abort.aborted) onAbort()
  else ctx.abort.addEventListener("abort", onAbort, { once: true })

  // EOF or shutdown: abort the active run, wait until every in-flight
  // request has replied (the prompt replies `cancelled`), then close the
  // session so core fires sessionEnd.
  await channel.closed
  ctx.abort.removeEventListener("abort", onAbort)
  activeRun?.abort()
  // A waiting permission request already rejected at EOF / stop(), so the
  // prompt can finish and `idle()` can resolve.
  await channel.idle()
  setActiveGate(undefined)
  if (session) {
    try {
      await session.close()
    } catch (e) {
      ctx.log.warn("acp", `session.close failed: ${errorText(e)}`)
    }
  }
  return 0
}

export default handler
