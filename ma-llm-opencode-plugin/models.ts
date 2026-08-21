/**
 * OpenCode Go model registry entries.
 *
 * Triple-surface: OpenAI Chat Completions (DeepSeek, GLM, Kimi, MiMo, Hy,
 * Grok), Anthropic Messages (MiniMax, Qwen), and OpenAI Responses
 * (GPT-5.6 Luna, Muse Spark 1.2 Contributor) share the same provider id but
 * dispatch through their
 * respective wire translators.
 *
 * Each model has its own `Capabilities` record and `MTokRate` — no buckets.
 * IDs: live `https://opencode.ai/zen/go/v1/models`. Caps: models.dev
 * `opencode-go`. Pricing: docs/go first, models.dev for omitted slugs
 * (2026-08-20).
 *
 * @module llm/providers/opencode/models
 */

import {
  CAPS_DEEPSEEK_V4_FLASH,
  CAPS_DEEPSEEK_V4_PRO,
  CAPS_GLM_5,
  CAPS_GLM_5_1,
  CAPS_GLM_5_2,
  CAPS_GLM_5_3,
  CAPS_GPT_5_6_LUNA,
  CAPS_GROK_4_5,
  CAPS_HY3,
  CAPS_HY3_PREVIEW,
  CAPS_KIMI_K2_5,
  CAPS_KIMI_K2_6,
  CAPS_KIMI_K2_7_CODE,
  CAPS_KIMI_K3,
  CAPS_MIMO_V2_5,
  CAPS_MIMO_V2_5_PRO,
  CAPS_MIMO_V2_OMNI,
  CAPS_MIMO_V2_PRO,
  CAPS_MINIMAX_M2_5,
  CAPS_MINIMAX_M2_7,
  CAPS_MINIMAX_M3,
  CAPS_MUSE_SPARK_1_2_CONTRIBUTOR,
  CAPS_QWEN3_5_PLUS,
  CAPS_QWEN3_6_PLUS,
  CAPS_QWEN3_7_MAX,
  CAPS_QWEN3_7_PLUS,
  CAPS_QWEN3_8_MAX,
} from "./capabilities.ts"
import type { Capabilities } from "./lib/capabilities.ts"
import type { SurfaceId } from "./lib/host-types.ts"
import type { ModelRegistrar, ProviderModelSpec } from "./lib/provider-plugin.ts"
import { makeCharRatioEstimator } from "./lib/token-estimate.ts"
import {
  PRICING_DEEPSEEK_V4_FLASH,
  PRICING_DEEPSEEK_V4_PRO,
  PRICING_GLM_5,
  PRICING_GLM_5_1,
  PRICING_GLM_5_2,
  PRICING_GLM_5_3,
  PRICING_GPT_5_6_LUNA,
  PRICING_GROK_4_5,
  PRICING_HY3,
  PRICING_HY3_PREVIEW,
  PRICING_KIMI_K2_5,
  PRICING_KIMI_K2_6,
  PRICING_KIMI_K2_7_CODE,
  PRICING_KIMI_K3,
  PRICING_MIMO_V2_5,
  PRICING_MIMO_V2_5_PRO,
  PRICING_MIMO_V2_OMNI,
  PRICING_MIMO_V2_PRO,
  PRICING_MINIMAX_M2_5,
  PRICING_MINIMAX_M2_7,
  PRICING_MINIMAX_M3,
  PRICING_MUSE_SPARK_1_2_CONTRIBUTOR,
  PRICING_QWEN3_5_PLUS,
  PRICING_QWEN3_6_PLUS,
  PRICING_QWEN3_7_MAX,
  PRICING_QWEN3_7_PLUS,
  PRICING_QWEN3_8_MAX,
} from "./pricing.ts"

const estimateTokens = makeCharRatioEstimator(3.8)

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
    providerId: "opencode",
    surfaceId: opts.surfaceId,
    displayName: opts.displayName,
    tags: opts.tags,
    capabilities: opts.capabilities,
    estimateTokens,
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
      tags: ["opencode", "openai-compatible", "deepseek"],
      capabilities: CAPS_DEEPSEEK_V4_PRO,
      pricing: PRICING_DEEPSEEK_V4_PRO,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("deepseek-v4-flash", {
      displayName: "DeepSeek V4 Flash",
      tags: ["opencode", "openai-compatible", "deepseek", "cheap"],
      capabilities: CAPS_DEEPSEEK_V4_FLASH,
      pricing: PRICING_DEEPSEEK_V4_FLASH,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("glm-5.3", {
      displayName: "GLM-5.3",
      tags: ["opencode", "openai-compatible", "glm"],
      capabilities: CAPS_GLM_5_3,
      pricing: PRICING_GLM_5_3,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("glm-5.2", {
      displayName: "GLM-5.2",
      tags: ["opencode", "openai-compatible", "glm"],
      capabilities: CAPS_GLM_5_2,
      pricing: PRICING_GLM_5_2,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("glm-5.1", {
      displayName: "GLM-5.1",
      tags: ["opencode", "openai-compatible", "glm"],
      capabilities: CAPS_GLM_5_1,
      pricing: PRICING_GLM_5_1,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("glm-5", {
      displayName: "GLM-5",
      tags: ["opencode", "openai-compatible", "glm"],
      capabilities: CAPS_GLM_5,
      pricing: PRICING_GLM_5,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("kimi-k2.7-code", {
      displayName: "Kimi K2.7 Code",
      tags: ["opencode", "openai-compatible", "kimi"],
      capabilities: CAPS_KIMI_K2_7_CODE,
      pricing: PRICING_KIMI_K2_7_CODE,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("kimi-k2.6", {
      displayName: "Kimi K2.6",
      tags: ["opencode", "openai-compatible", "kimi"],
      capabilities: CAPS_KIMI_K2_6,
      pricing: PRICING_KIMI_K2_6,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("kimi-k2.5", {
      displayName: "Kimi K2.5",
      tags: ["opencode", "openai-compatible", "kimi"],
      capabilities: CAPS_KIMI_K2_5,
      pricing: PRICING_KIMI_K2_5,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("kimi-k3", {
      displayName: "Kimi K3",
      tags: ["opencode", "openai-compatible", "kimi", "flagship"],
      capabilities: CAPS_KIMI_K3,
      pricing: PRICING_KIMI_K3,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("grok-4.5", {
      displayName: "Grok 4.5",
      tags: ["opencode", "openai-compatible", "grok"],
      capabilities: CAPS_GROK_4_5,
      pricing: PRICING_GROK_4_5,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("hy3", {
      displayName: "Hy3",
      tags: ["opencode", "openai-compatible", "hy"],
      capabilities: CAPS_HY3,
      pricing: PRICING_HY3,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("hy3-preview", {
      displayName: "Hy3 Preview",
      tags: ["opencode", "openai-compatible", "hy"],
      capabilities: CAPS_HY3_PREVIEW,
      pricing: PRICING_HY3_PREVIEW,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("mimo-v2.5", {
      displayName: "MiMo-V2.5",
      tags: ["opencode", "openai-compatible", "mimo"],
      capabilities: CAPS_MIMO_V2_5,
      pricing: PRICING_MIMO_V2_5,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("mimo-v2.5-pro", {
      displayName: "MiMo-V2.5-Pro",
      tags: ["opencode", "openai-compatible", "mimo"],
      capabilities: CAPS_MIMO_V2_5_PRO,
      pricing: PRICING_MIMO_V2_5_PRO,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("mimo-v2-pro", {
      displayName: "MiMo-V2-Pro",
      tags: ["opencode", "openai-compatible", "mimo"],
      capabilities: CAPS_MIMO_V2_PRO,
      pricing: PRICING_MIMO_V2_PRO,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("mimo-v2-omni", {
      displayName: "MiMo-V2-Omni",
      tags: ["opencode", "openai-compatible", "mimo"],
      capabilities: CAPS_MIMO_V2_OMNI,
      pricing: PRICING_MIMO_V2_OMNI,
      surfaceId: "openai-chat-completions",
    }),

    // OpenAI Responses surface
    makeSpec("gpt-5.6-luna", {
      displayName: "GPT-5.6 Luna",
      tags: ["opencode", "openai-responses", "gpt"],
      capabilities: CAPS_GPT_5_6_LUNA,
      pricing: PRICING_GPT_5_6_LUNA,
      surfaceId: "openai-responses",
    }),

    makeSpec("muse-spark-1.2-contributor", {
      displayName: "Muse Spark 1.2 Contributor",
      tags: ["opencode", "openai-responses", "muse"],
      capabilities: CAPS_MUSE_SPARK_1_2_CONTRIBUTOR,
      pricing: PRICING_MUSE_SPARK_1_2_CONTRIBUTOR,
      surfaceId: "openai-responses",
    }),

    // Anthropic Messages surface
    makeSpec("minimax-m3", {
      displayName: "MiniMax M3",
      tags: ["opencode", "anthropic-compatible", "minimax"],
      capabilities: CAPS_MINIMAX_M3,
      pricing: PRICING_MINIMAX_M3,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("minimax-m2.7", {
      displayName: "MiniMax M2.7",
      tags: ["opencode", "anthropic-compatible", "minimax"],
      capabilities: CAPS_MINIMAX_M2_7,
      pricing: PRICING_MINIMAX_M2_7,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("minimax-m2.5", {
      displayName: "MiniMax M2.5",
      tags: ["opencode", "anthropic-compatible", "minimax"],
      capabilities: CAPS_MINIMAX_M2_5,
      pricing: PRICING_MINIMAX_M2_5,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("qwen3.8-max", {
      displayName: "Qwen3.8 Max",
      tags: ["opencode", "anthropic-compatible", "qwen", "flagship"],
      capabilities: CAPS_QWEN3_8_MAX,
      pricing: PRICING_QWEN3_8_MAX,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("qwen3.7-max", {
      displayName: "Qwen3.7 Max",
      tags: ["opencode", "anthropic-compatible", "qwen"],
      capabilities: CAPS_QWEN3_7_MAX,
      pricing: PRICING_QWEN3_7_MAX,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("qwen3.7-plus", {
      displayName: "Qwen3.7 Plus",
      tags: ["opencode", "anthropic-compatible", "qwen"],
      capabilities: CAPS_QWEN3_7_PLUS,
      pricing: PRICING_QWEN3_7_PLUS,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("qwen3.6-plus", {
      displayName: "Qwen3.6 Plus",
      tags: ["opencode", "anthropic-compatible", "qwen"],
      capabilities: CAPS_QWEN3_6_PLUS,
      pricing: PRICING_QWEN3_6_PLUS,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("qwen3.5-plus", {
      displayName: "Qwen3.5 Plus",
      tags: ["opencode", "anthropic-compatible", "qwen"],
      capabilities: CAPS_QWEN3_5_PLUS,
      pricing: PRICING_QWEN3_5_PLUS,
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
  registrar.register(spec)
  localCatalog.push({ id: spec.id, tags: spec.tags ?? [] })
  return spec.id
}
