/**
 * ACP session config options (https://agentclientprotocol.com/protocol/v1/session-config-options)
 * for model and effort, built from the host-mode context functions
 * (`listModels`, `modelInfo`, `getModel`, `setModel`, `getEffort`,
 * `setEffort`). The plugin never imports the model registry or `AgentCore`
 * (spec v3 section 10b, Q16, Q17).
 *
 * Rules:
 * - `model` (category `model`) lists the CURRENT provider's models only
 *   (Level 1, `listModels()` is already filtered by the host).
 * - `effort` (category `thought_level`) lists the current model's effort
 *   levels. It is LEFT OUT when the model has no levels; a set for it is
 *   then invalid params.
 * - Every reply and every `config_option_update` carries the COMPLETE list,
 *   rebuilt from live state. A model change can reset effort to the model
 *   default (core does this); the rebuilt list shows the result.
 * - A set to the current value is a no-op: no setter call, the same list.
 * - Unknown `configId`, a value not in the option's list, a boolean value,
 *   or a throw from the core setter: JSON-RPC -32602, state unchanged (the
 *   core setters change nothing when they throw).
 * - A change applies from the NEXT model request, which can be inside the
 *   running turn.
 *
 * @module config-options
 */

import type { HostRuntime } from "@minimal-agent/core/host-kit/host-mode"

import { errorText } from "./error-text.ts"
import { RPC_ERROR, RpcError } from "./transport.ts"

/** The part of the host runtime this module uses. */
export type ConfigRuntime = Pick<
  HostRuntime,
  "listModels" | "modelInfo" | "getModel" | "setModel" | "getEffort" | "setEffort"
>

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
  readonly category: "model" | "thought_level"
  readonly type: "select"
  readonly currentValue: string
  readonly options: readonly AcpSelectOption[]
}

/** Config option ids. */
export const CONFIG_ID = { model: "model", effort: "effort" } as const

const APPLY_NOTE = "Applies from the next model request, which can be inside the running turn."

/** Build the complete option list from live state. Order is priority: model, then effort. */
export function buildConfigOptions(runtime: ConfigRuntime): AcpConfigOption[] {
  const model = runtime.getModel()
  const options: AcpConfigOption[] = [modelOption(runtime, model)]
  const effort = effortOption(runtime, model)
  if (effort) options.push(effort)
  return options
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
 * setter, and return the complete rebuilt list.
 *
 * @throws RpcError -32602 on an unknown id, a bad value, or a setter throw. State is unchanged then.
 */
export function setConfigOption(
  runtime: ConfigRuntime,
  configId: unknown,
  value: unknown,
): AcpConfigOption[] {
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
    if (option.id === CONFIG_ID.model) runtime.setModel(value)
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
