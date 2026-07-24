/**
 * Capability validation for the Cursor adapter.
 *
 * Pure: no network. Safe to call before dispatch.
 *
 * @module llm/providers/cursor/validate
 */

import type { CanonicalRequest } from "./lib/canonical-request.ts"
import { CapabilityViolation } from "./lib/errors.ts"
import { modalityViolations } from "./lib/modality-check.ts"
import type { ModelView, ProviderValidationResult } from "./lib/provider-plugin.ts"

/**
 * Validate a canonical request against a Cursor model's declared capabilities.
 */
export function validateCursorRequest(
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

  const thinking = req.thinking
  if (thinking) {
    const canThink =
      caps.thinking.adaptive || caps.thinking.visible || caps.effort.levels.length > 0
    if (!canThink) {
      errors.push(new CapabilityViolation("thinking", `model ${model.id} doesn't support thinking`))
    }
  }

  if (req.effort && !caps.effort.levels.includes(req.effort)) {
    errors.push(
      new CapabilityViolation(
        "effort",
        `model ${model.id} reasoning levels are [${caps.effort.levels.join(", ")}], not "${req.effort}"`,
      ),
    )
  }

  const hasMidConvSystem = req.messages.some((m) => m.role === "system")
  if (hasMidConvSystem && !caps.midConversationSystem) {
    errors.push(
      new CapabilityViolation(
        "midConversationSystem",
        `model ${model.id} rejects role:"system" inside messages[]`,
      ),
    )
  }

  if (req.speed === "fast" && !caps.speedFast) {
    errors.push(
      new CapabilityViolation("speedFast", `model ${model.id} doesn't support speed:"fast"`),
    )
  }

  errors.push(...modalityViolations(req.messages, caps, model.id))

  return { ok: errors.length === 0, errors }
}
