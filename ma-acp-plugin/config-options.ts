/**
 * ACP session config options (https://agentclientprotocol.com/protocol/v1/session-config-options)
 * for provider, model, and effort, built from the host-mode context
 * functions (`listTargets`, `getTarget`, `setTarget`, `listModels`,
 * `modelInfo`, `getModel`, `setModel`, `getEffort`, `setEffort`). The
 * plugin never imports the model registry or `AgentCore` (spec v3 section
 * 10b, Q16, Q17).
 *
 * Rules:
 * - `provider` (category `_provider`) lists one row per provider +
 *   credential pair. It is LEFT OUT when the host has no `listTargets`,
 *   `getTarget`, and `setTarget` (an older host), or lists no rows. The
 *   value is the provider id, or `<providerId>:c-<10 hex>` (a sha256 of the
 *   credential name) when a credential is named. The credential name (often
 *   an email) is ONLY in the label: clients such as Zed persist values. A
 *   set looks the value up in the built list, it never parses it.
 * - `model` (category `model`) lists the LIVE provider's models only
 *   (`listModels()` is already filtered by the host). A provider change
 *   keeps the model when the new provider has it, else the provider default.
 * - `effort` (category `thought_level`) lists the current model's effort
 *   levels. It is LEFT OUT when the model has no levels; a set for it is
 *   then invalid params.
 * - Every reply and every `config_option_update` carries the COMPLETE list,
 *   rebuilt from live state. A model change can reset effort to the model
 *   default (core does this); the rebuilt list shows the result.
 * - Order is priority: provider, model, effort.
 * - A set to the current value is a no-op: no setter call, the same list.
 * - Unknown `configId`, a value not in the option's list, a boolean value,
 *   or a throw from the core setter: JSON-RPC -32602, state unchanged (the
 *   core setters change nothing when they throw).
 * - A change applies from the NEXT model request, which can be inside the
 *   running turn.
 *
 * @module config-options
 */

import { createHash } from "node:crypto"

import type { HostRuntime } from "@minimal-agent/core/host-kit/host-mode"

import { errorText } from "./error-text.ts"
import { RPC_ERROR, RpcError } from "./transport.ts"

/**
 * The part of the host runtime this module uses. The target members are
 * optional: an older host does not have them, so this module feature-detects.
 */
export type ConfigRuntime = Pick<
  HostRuntime,
  "listModels" | "modelInfo" | "getModel" | "setModel" | "getEffort" | "setEffort"
> &
  Partial<Pick<HostRuntime, "listTargets" | "getTarget" | "setTarget">>

/** One ACP `SessionConfigSelectOption`. */
export interface AcpSelectOption {
  readonly value: string
  readonly name: string
  readonly description?: string
}

/** One ACP `SessionConfigOption` of type `select` (the only type this plugin sends). */
export interface AcpConfigOption {
  readonly id: string
  readonly name: string
  readonly description?: string
  /** ACP categories, plus `_provider` (a `_` prefix is the ACP custom category form). */
  readonly category: "model" | "thought_level" | "_provider"
  readonly type: "select"
  readonly currentValue: string
  readonly options: readonly AcpSelectOption[]
}

/** Config option ids. */
export const CONFIG_ID = { provider: "provider", model: "model", effort: "effort" } as const

const APPLY_NOTE = "Applies from the next model request, which can be inside the running turn."

/** One provider row: the option value plus the target it selects. */
interface ProviderChoice {
  readonly value: string
  readonly name: string
  readonly target: { providerId: string; credentialName?: string }
}

/**
 * The option value for a provider + credential pair. A credential name is
 * hashed, so no email or account name reaches a persisted client setting.
 */
export function providerValue(providerId: string, credentialName?: string): string {
  if (credentialName === undefined) return providerId
  const slug = createHash("sha256").update(credentialName).digest("hex").slice(0, 10)
  return `${providerId}:c-${slug}`
}

/** The provider rows, or `undefined` when the host cannot switch targets. */
function providerChoices(runtime: ConfigRuntime): ProviderChoice[] | undefined {
  if (!runtime.listTargets || !runtime.getTarget || !runtime.setTarget) return undefined
  const rows = runtime.listTargets()
  if (rows.length === 0) return undefined
  return rows.map((r) => ({
    value: providerValue(r.providerId, r.credentialName),
    name: r.label,
    target: {
      providerId: r.providerId,
      ...(r.credentialName !== undefined ? { credentialName: r.credentialName } : {}),
    },
  }))
}

/** Build the complete option list from live state. Order is priority: provider, model, effort. */
export function buildConfigOptions(runtime: ConfigRuntime): AcpConfigOption[] {
  const options: AcpConfigOption[] = []
  const provider = providerOption(runtime, providerChoices(runtime))
  if (provider) options.push(provider)
  const model = runtime.getModel()
  options.push(modelOption(runtime, model))
  const effort = effortOption(runtime, model)
  if (effort) options.push(effort)
  return options
}

function providerOption(
  runtime: ConfigRuntime,
  choices: ProviderChoice[] | undefined,
): AcpConfigOption | undefined {
  if (!choices || !runtime.getTarget) return undefined
  const live = runtime.getTarget()
  const currentValue =
    live.providerId !== undefined
      ? providerValue(live.providerId, live.credentialName)
      : (choices[0]?.value ?? "")
  const options: AcpSelectOption[] = choices.map((c) => ({ value: c.value, name: c.name }))
  // `currentValue` must always be one of the options (the host lists the
  // live target, this is a guard for a host that does not).
  if (live.providerId !== undefined && !options.some((o) => o.value === currentValue)) {
    options.unshift({ value: currentValue, name: live.providerId })
  }
  return {
    id: CONFIG_ID.provider,
    name: "Provider",
    description:
      "Provider and credential for this session. Changing it resets the model to that " +
      `provider's default when the current model is not available. ${APPLY_NOTE}`,
    category: "_provider",
    type: "select",
    currentValue,
    options,
  }
}
function modelOption(runtime: ConfigRuntime, current: string): AcpConfigOption {
  const choices: AcpSelectOption[] = runtime
    .listModels()
    .map((m) => ({ value: m.id, name: m.label }))
  // `currentValue` must always be one of the options, even for a model the
  // registry list does not show (for example a custom id from the command line).
  if (!choices.some((c) => c.value === current)) {
    choices.unshift({ value: current, name: runtime.modelInfo(current)?.displayName ?? current })
  }
  return {
    id: CONFIG_ID.model,
    name: "Model",
    description: `Model for this session. ${APPLY_NOTE}`,
    category: "model",
    type: "select",
    currentValue: current,
    options: choices,
  }
}

function effortOption(runtime: ConfigRuntime, model: string): AcpConfigOption | undefined {
  const info = runtime.modelInfo(model)
  const levels = info?.effort.levels ?? []
  if (!info || levels.length === 0) return undefined
  // `undefined` effort means the model default.
  const current = runtime.getEffort() ?? info.effort.default
  const choices: AcpSelectOption[] = levels.map((level) => ({
    value: level,
    name: level === info.effort.default ? `${level} (default)` : level,
  }))
  return {
    id: CONFIG_ID.effort,
    name: "Effort",
    description: `Reasoning effort. ${APPLY_NOTE}`,
    category: "thought_level",
    type: "select",
    currentValue: current,
    options: choices,
  }
}

/**
 * Handle `session/set_config_option`: validate, apply through the core
 * setter, and return the complete rebuilt list. Async: the provider setter
 * resolves auth first.
 *
 * @throws RpcError -32602 on an unknown id, a bad value, or a setter throw. State is unchanged then.
 */
export async function setConfigOption(
  runtime: ConfigRuntime,
  configId: unknown,
  value: unknown,
): Promise<AcpConfigOption[]> {
  const choices = providerChoices(runtime)
  const current = buildConfigOptions(runtime)
  const option = current.find((o) => o.id === configId)
  if (!option) {
    throw new RpcError(RPC_ERROR.invalidParams, `unknown config option: ${String(configId)}`)
  }
  if (typeof value !== "string" || !option.options.some((o) => o.value === value)) {
    throw new RpcError(
      RPC_ERROR.invalidParams,
      `invalid value for config option "${option.id}": ${JSON.stringify(value)}`,
    )
  }
  if (value === option.currentValue) return current
  try {
    if (option.id === CONFIG_ID.provider) {
      // Decode by lookup in the built list, never by parsing the value.
      const choice = choices?.find((c) => c.value === value)
      if (!choice || !runtime.setTarget) throw new Error("provider is not in the target list")
      await runtime.setTarget(choice.target)
    } else if (option.id === CONFIG_ID.model) runtime.setModel(value)
    else runtime.setEffort(value)
  } catch (e) {
    const detail = errorText(e)
    throw new RpcError(
      RPC_ERROR.invalidParams,
      `cannot set "${option.id}" to "${value}": ${detail}`,
    )
  }
  return buildConfigOptions(runtime)
}
