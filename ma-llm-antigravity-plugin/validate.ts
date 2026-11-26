/**
 * Capability validation for the Antigravity adapter.
 *
 * Pure: no network, no I/O. The host calls this before dispatch, so a request
 * that the model cannot serve never spends plan quota.
 *
 * The backend accepts a request that the model does not support, and then the
 * turn fails with an unhelpful 400. This file gives the same answer earlier,
 * with a named violation.
 *
 * @module llm/providers/antigravity/validate
 */

import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import { CapabilityViolation } from "@minimal-agent/core/plugin-api/llm/errors"
import { modalityViolations } from "@minimal-agent/core/plugin-api/llm/modality-check"
import type { ProviderValidationResult } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

import type { ModelView } from "./lib/host-types.ts"

/** Validate a canonical request against one Antigravity model. */
export function validateAntigravityRequest(
  req: CanonicalRequest,
  model: ModelView,
): ProviderValidationResult {
  const errors: CapabilityViolation[] = []
  const caps = model.capabilities

  if (req.generation?.temperature !== undefined && !caps.acceptsTemperature) {
    errors.push(
      new CapabilityViolation("acceptsTemperature", `model ${model.id} rejects temperature`),
    )
  }
  if (req.generation?.topP !== undefined && !caps.acceptsTopP) {
    errors.push(new CapabilityViolation("acceptsTopP", `model ${model.id} rejects top_p`))
  }
  if (req.generation?.topK !== undefined && !caps.acceptsTopK) {
    errors.push(new CapabilityViolation("acceptsTopK", `model ${model.id} rejects top_k`))
  }
  if (req.generation?.seed !== undefined && !caps.acceptsSeed) {
    errors.push(new CapabilityViolation("acceptsSeed", `model ${model.id} rejects seed`))
  }

  if (req.thinking) {
    const canThink = caps.thinking.adaptive || caps.effort.levels.length > 0
    if (req.thinking.mode === "adaptive" && !canThink) {
      errors.push(
        new CapabilityViolation("thinking.adaptive", `model ${model.id} has no thinking mode`),
      )
    }
    if (req.thinking.mode === "extended" && !caps.thinking.extended) {
      errors.push(
        new CapabilityViolation("thinking.extended", `model ${model.id} has no token budget`),
      )
    }
  }

  if (req.effort && !caps.effort.levels.includes(req.effort)) {
    errors.push(
      new CapabilityViolation(
        "effort",
        `model ${model.id} levels are [${caps.effort.levels.join(", ")}], not "${req.effort}"`,
      ),
    )
  }

  if (req.speed === "fast" && !caps.speedFast) {
    errors.push(new CapabilityViolation("speedFast", `model ${model.id} has no fast tier`))
  }

  if (req.outputFormat?.type === "json_schema" && !caps.structuredOutputs) {
    errors.push(
      new CapabilityViolation("structuredOutputs", `model ${model.id} has no JSON schema output`),
    )
  }

  if (req.previousResponseId && !caps.serverSideHistory) {
    errors.push(
      new CapabilityViolation(
        "serverSideHistory",
        `model ${model.id} keeps no history; send full messages[]`,
      ),
    )
  }

  errors.push(...modalityViolations(req.messages, caps, model.id))

  return { ok: errors.length === 0, errors }
}
