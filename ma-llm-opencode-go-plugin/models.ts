/**
 * OpenCode Go model registry entries.
 *
 * Triple-surface: OpenAI Chat Completions (DeepSeek, GLM, Kimi, MiMo, Hy,
 * LongCat, Omen, Space Bunny, Step), Anthropic Messages (MiniMax, Qwen,
 * Claude Haiku), and OpenAI Responses (GPT Luna, Grok, Muse Spark
 * Contributor) share the same provider id but dispatch through their
 * respective wire translators.
 *
 * Each model has its own `Capabilities` record and `MTokRate` — no buckets.
 * IDs: live `https://opencode.ai/zen/go/v1/models`. Caps: models.dev
 * `opencode-go`. Pricing: docs/go first, models.dev for omitted slugs
 * (2026-11-18).
 *
 * @module llm/providers/opencode/models
 */

import type { Capabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"

import { estimatorForModelId } from "../ma-token-estimate-kit/src/index.ts"

import {
  CAPS_BEAM_FREE,
  CAPS_CLAUDE_HAIKU_5_5,
  CAPS_DEEPSEEK_V4_1_FLASH,
  CAPS_DEEPSEEK_V4_PRO,
  CAPS_GEMINI_4_ARGON,
  CAPS_GLM_5_2,
  CAPS_GLM_5_3,
  CAPS_GLM_5_3_FLASH,
  CAPS_GPT_5_6_LUNA,
  CAPS_GPT_6_LUNA,
  CAPS_GROK_4_7,
  CAPS_HY3,
  CAPS_HY4,
  CAPS_HY4_FLASH_FREE,
  CAPS_HY4_PREVIEW,
  CAPS_ICEMAN_CONTRIBUTOR_FREE,
  CAPS_KIMI_K2_7_CODE,
  CAPS_KIMI_K3,
  CAPS_KIMI_K3_1_PRO,
  CAPS_LONGCAT_2_0,
  CAPS_LONGCAT_2_5_FREE,
  CAPS_MIMO_V2_6_FLASH,
  CAPS_MIMO_V2_6_PRO,
  CAPS_MINIMAX_M3,
  CAPS_MINIMAX_M3_1_FLASH,
  CAPS_MUSE_SPARK_1_2_CONTRIBUTOR,
  CAPS_MUSE_SPARK_1_3_CONTRIBUTOR,
  CAPS_QWEN3_7_PLUS,
  CAPS_QWEN3_8_FLASH,
  CAPS_QWEN3_8_MAX,
  CAPS_QWEN4_MAX,
  CAPS_STEP_5_PREVIEW,
} from "./capabilities.ts"
import { withOpencodeInputMimeTypes } from "./input-formats.ts"
import type { SurfaceId } from "./lib/host-types.ts"
import type { ModelRegistrar, ProviderModelSpec } from "./lib/provider-plugin.ts"
import {
  PRICING_BEAM_FREE,
  PRICING_CLAUDE_HAIKU_5_5,
  PRICING_DEEPSEEK_V4_1_FLASH,
  PRICING_DEEPSEEK_V4_PRO,
  PRICING_GEMINI_4_ARGON,
  PRICING_GLM_5_2,
  PRICING_GLM_5_3,
  PRICING_GLM_5_3_FLASH,
  PRICING_GPT_5_6_LUNA,
  PRICING_GPT_6_LUNA,
  PRICING_GROK_4_7,
  PRICING_HY3,
  PRICING_HY4,
  PRICING_HY4_FLASH_FREE,
  PRICING_HY4_PREVIEW,
  PRICING_ICEMAN_CONTRIBUTOR_FREE,
  PRICING_KIMI_K2_7_CODE,
  PRICING_KIMI_K3,
  PRICING_KIMI_K3_1_PRO,
  PRICING_LONGCAT_2_0,
  PRICING_LONGCAT_2_5_FREE,
  PRICING_MIMO_V2_6_FLASH,
  PRICING_MIMO_V2_6_PRO,
  PRICING_MINIMAX_M3,
  PRICING_MINIMAX_M3_1_FLASH,
  PRICING_MUSE_SPARK_1_2_CONTRIBUTOR,
  PRICING_MUSE_SPARK_1_3_CONTRIBUTOR,
  PRICING_QWEN3_7_PLUS,
  PRICING_QWEN3_8_FLASH,
  PRICING_QWEN3_8_MAX,
  PRICING_QWEN4_MAX,
  PRICING_STEP_5_PREVIEW,
} from "./pricing.ts"

/**
 * Fallback tokenizer family for an id that the kit map does not know (for
 * example `step-*` or `beam-free`). OpenCode Go serves models of many
 * vendors, so `generic` (the fit on the union of 12 reference tokenizers) is
 * the safest guess.
 */
const GO_FALLBACK_FAMILY = "generic" as const

interface OpencodeModelSpec extends ProviderModelSpec {
  surfaceId: SurfaceId
}

function makeSpec(
  id: string,
  opts: {
    displayName: string
    surfaceId: SurfaceId
    capabilities: Capabilities
    pricing: OpencodeModelSpec["pricing"]
    tags: string[]
  },
): OpencodeModelSpec {
  return {
    id,
    providerId: "opencode-go",
    surfaceId: opts.surfaceId,
    displayName: opts.displayName,
    tags: opts.tags,
    // Per-model input formats: the live list, else the static flags.
    capabilities: withOpencodeInputMimeTypes(opts.capabilities, id, opts.surfaceId),
    estimateTokens: estimatorForModelId(id, GO_FALLBACK_FAMILY),
    pricing: opts.pricing,
    vendorIds: { firstParty: id },
  }
}

type ModelSink = (spec: OpencodeModelSpec) => void

/**
 * Local catalog of id + tags captured at registration, so the adapter can pick
 * scout/balanced models from this provider's OWN catalog without a host
 * registry read. A moved plugin can't reach host registry state.
 */
const localCatalog: Array<{ id: string; tags: readonly string[] }> = []

/** Find the first registered model whose tags include all of `mustHave`. */
export function findOpencodeModelByTags(mustHave: readonly string[]): string | undefined {
  return localCatalog.find((m) => mustHave.every((t) => m.tags.includes(t)))?.id
}

/**
 * Register the full OpenCode Go model catalog through the setup-context
 * registrar (the `models:register` capability). As a moved plugin this always
 * runs with a real registrar handed in at `register(ctx)`; there is no
 * host-registry fallback import. Returns the registered model ids.
 */
export function registerOpencodeModels(registrar: ModelRegistrar): string[] {
  localCatalog.length = 0
  const register: ModelSink = (spec) => {
    registrar.register(spec)
    localCatalog.push({ id: spec.id, tags: spec.tags ?? [] })
  }

  const models: OpencodeModelSpec[] = [
    // OpenAI Chat Completions surface
    makeSpec("deepseek-v4-pro", {
      displayName: "DeepSeek V4 Pro",
      tags: ["opencode-go", "openai-compatible", "deepseek"],
      capabilities: CAPS_DEEPSEEK_V4_PRO,
      pricing: PRICING_DEEPSEEK_V4_PRO,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("deepseek-v4.1-flash", {
      displayName: "DeepSeek V4.1 Flash",
      tags: ["opencode-go", "openai-compatible", "deepseek", "cheap"],
      capabilities: CAPS_DEEPSEEK_V4_1_FLASH,
      pricing: PRICING_DEEPSEEK_V4_1_FLASH,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("glm-5.3-flash", {
      displayName: "GLM-5.3-Flash",
      tags: ["opencode-go", "openai-compatible", "glm", "cheap"],
      capabilities: CAPS_GLM_5_3_FLASH,
      pricing: PRICING_GLM_5_3_FLASH,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("glm-5.3", {
      displayName: "GLM-5.3",
      tags: ["opencode-go", "openai-compatible", "glm"],
      capabilities: CAPS_GLM_5_3,
      pricing: PRICING_GLM_5_3,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("glm-5.2", {
      displayName: "GLM-5.2",
      tags: ["opencode-go", "openai-compatible", "glm"],
      capabilities: CAPS_GLM_5_2,
      pricing: PRICING_GLM_5_2,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("kimi-k2.7-code", {
      displayName: "Kimi K2.7 Code",
      tags: ["opencode-go", "openai-compatible", "kimi"],
      capabilities: CAPS_KIMI_K2_7_CODE,
      pricing: PRICING_KIMI_K2_7_CODE,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("kimi-k3", {
      displayName: "Kimi K3",
      tags: ["opencode-go", "openai-compatible", "kimi", "flagship"],
      capabilities: CAPS_KIMI_K3,
      pricing: PRICING_KIMI_K3,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("hy3", {
      displayName: "Hy3",
      tags: ["opencode-go", "openai-compatible", "hy"],
      capabilities: CAPS_HY3,
      pricing: PRICING_HY3,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("hy4", {
      displayName: "Hy4",
      tags: ["opencode-go", "openai-compatible", "hy"],
      capabilities: CAPS_HY4,
      pricing: PRICING_HY4,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("hy4-preview", {
      displayName: "Hy4 Preview",
      tags: ["opencode-go", "openai-compatible", "hy"],
      capabilities: CAPS_HY4_PREVIEW,
      pricing: PRICING_HY4_PREVIEW,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("hy4-flash-free", {
      displayName: "Hy4 Flash Free",
      tags: ["opencode-go", "openai-compatible", "hy", "free", "cheap"],
      capabilities: CAPS_HY4_FLASH_FREE,
      pricing: PRICING_HY4_FLASH_FREE,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("longcat-2.0", {
      displayName: "LongCat-2.0",
      tags: ["opencode-go", "openai-compatible", "longcat"],
      capabilities: CAPS_LONGCAT_2_0,
      pricing: PRICING_LONGCAT_2_0,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("longcat-2.5-free", {
      displayName: "LongCat 2.5 Free",
      tags: ["opencode-go", "openai-compatible", "longcat", "free", "cheap"],
      capabilities: CAPS_LONGCAT_2_5_FREE,
      pricing: PRICING_LONGCAT_2_5_FREE,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("mimo-v2.6-flash", {
      displayName: "MiMo-V2.6-Flash",
      tags: ["opencode-go", "openai-compatible", "mimo"],
      capabilities: CAPS_MIMO_V2_6_FLASH,
      pricing: PRICING_MIMO_V2_6_FLASH,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("mimo-v2.6-pro", {
      displayName: "MiMo-V2.6-Pro",
      tags: ["opencode-go", "openai-compatible", "mimo"],
      capabilities: CAPS_MIMO_V2_6_PRO,
      pricing: PRICING_MIMO_V2_6_PRO,
      surfaceId: "openai-chat-completions",
    }),

    makeSpec("beam-free", {
      displayName: "Beam Free",
      tags: ["opencode-go", "openai-compatible", "beam", "free", "cheap"],
      capabilities: CAPS_BEAM_FREE,
      pricing: PRICING_BEAM_FREE,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("gemini-4-argon", {
      displayName: "Gemini 4 Argon",
      tags: ["opencode-go", "openai-compatible", "gemini", "flagship"],
      capabilities: CAPS_GEMINI_4_ARGON,
      pricing: PRICING_GEMINI_4_ARGON,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("iceman-contributor-free", {
      displayName: "Iceman Contributor Free",
      tags: ["opencode-go", "openai-compatible", "iceman", "free", "cheap"],
      capabilities: CAPS_ICEMAN_CONTRIBUTOR_FREE,
      pricing: PRICING_ICEMAN_CONTRIBUTOR_FREE,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("kimi-k3.1-pro", {
      displayName: "Kimi K3.1 Pro",
      tags: ["opencode-go", "openai-compatible", "kimi"],
      capabilities: CAPS_KIMI_K3_1_PRO,
      pricing: PRICING_KIMI_K3_1_PRO,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("minimax-m3.1-flash", {
      displayName: "MiniMax M3.1 Flash",
      tags: ["opencode-go", "openai-compatible", "minimax"],
      capabilities: CAPS_MINIMAX_M3_1_FLASH,
      pricing: PRICING_MINIMAX_M3_1_FLASH,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("step-5-preview", {
      displayName: "Step 5 Preview",
      tags: ["opencode-go", "openai-compatible", "step"],
      capabilities: CAPS_STEP_5_PREVIEW,
      pricing: PRICING_STEP_5_PREVIEW,
      surfaceId: "openai-chat-completions",
    }),

    // OpenAI Responses surface
    makeSpec("gpt-5.6-luna", {
      displayName: "GPT-5.6 Luna",
      tags: ["opencode-go", "openai-responses", "gpt"],
      capabilities: CAPS_GPT_5_6_LUNA,
      pricing: PRICING_GPT_5_6_LUNA,
      surfaceId: "openai-responses",
    }),
    makeSpec("gpt-6-luna", {
      displayName: "GPT-6 Luna",
      tags: ["opencode-go", "openai-responses", "gpt"],
      capabilities: CAPS_GPT_6_LUNA,
      pricing: PRICING_GPT_6_LUNA,
      surfaceId: "openai-responses",
    }),
    makeSpec("grok-4.7", {
      displayName: "Grok 4.7",
      tags: ["opencode-go", "openai-responses", "grok"],
      capabilities: CAPS_GROK_4_7,
      pricing: PRICING_GROK_4_7,
      surfaceId: "openai-responses",
    }),
    makeSpec("muse-spark-1.2-contributor", {
      displayName: "Muse Spark 1.2 Contributor",
      tags: ["opencode-go", "openai-responses", "muse"],
      capabilities: CAPS_MUSE_SPARK_1_2_CONTRIBUTOR,
      pricing: PRICING_MUSE_SPARK_1_2_CONTRIBUTOR,
      surfaceId: "openai-responses",
    }),
    makeSpec("muse-spark-1.3-contributor", {
      displayName: "Muse Spark 1.3 Contributor",
      tags: ["opencode-go", "openai-responses", "muse"],
      capabilities: CAPS_MUSE_SPARK_1_3_CONTRIBUTOR,
      pricing: PRICING_MUSE_SPARK_1_3_CONTRIBUTOR,
      surfaceId: "openai-responses",
    }),

    // Anthropic Messages surface
    makeSpec("minimax-m3", {
      displayName: "MiniMax M3",
      tags: ["opencode-go", "anthropic-compatible", "minimax"],
      capabilities: CAPS_MINIMAX_M3,
      pricing: PRICING_MINIMAX_M3,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("qwen3.8-max", {
      displayName: "Qwen3.8 Max",
      tags: ["opencode-go", "anthropic-compatible", "qwen", "flagship"],
      capabilities: CAPS_QWEN3_8_MAX,
      pricing: PRICING_QWEN3_8_MAX,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("qwen3.8-flash", {
      displayName: "Qwen3.8 Flash",
      tags: ["opencode-go", "anthropic-compatible", "qwen", "cheap"],
      capabilities: CAPS_QWEN3_8_FLASH,
      pricing: PRICING_QWEN3_8_FLASH,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("qwen3.7-plus", {
      displayName: "Qwen3.7 Plus",
      tags: ["opencode-go", "anthropic-compatible", "qwen"],
      capabilities: CAPS_QWEN3_7_PLUS,
      pricing: PRICING_QWEN3_7_PLUS,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("qwen4-max", {
      displayName: "Qwen4 Max",
      tags: ["opencode-go", "anthropic-compatible", "qwen", "flagship"],
      capabilities: CAPS_QWEN4_MAX,
      pricing: PRICING_QWEN4_MAX,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("claude-haiku-5-5", {
      displayName: "Claude Haiku 5.5",
      tags: ["opencode-go", "anthropic-compatible", "claude"],
      capabilities: CAPS_CLAUDE_HAIKU_5_5,
      pricing: PRICING_CLAUDE_HAIKU_5_5,
      surfaceId: "anthropic-messages",
    }),
  ]

  for (const spec of models) register(spec)

  return models.map((s) => s.id)
}

/**
 * Register a single OpenCode Go slug into the given registrar. Used for the
 * ad-hoc path (a slug the static catalog does not know yet).
 */
export function registerOpencodeModelInto(
  registrar: ModelRegistrar,
  spec: OpencodeModelSpec,
): string {
  registrar.register({
    ...spec,
    capabilities: withOpencodeInputMimeTypes(spec.capabilities, spec.id, spec.surfaceId),
    // An ad-hoc spec has no estimator: use the family of its id.
    estimateTokens: spec.estimateTokens ?? estimatorForModelId(spec.id, GO_FALLBACK_FAMILY),
  })
  localCatalog.push({ id: spec.id, tags: spec.tags ?? [] })
  return spec.id
}
