/**
 * Ollama Cloud model registry entries.
 *
 * Ollama Cloud (ollama.com) serves frontier open-weight models over its native
 * `/api/chat` protocol. The catalog below is a snapshot of the live cloud
 * `/api/tags` listing (https://ollama.com/api/tags) as of **2026-07-30** (19
 * slugs). The cloud API accepts the BARE model id (`deepseek-v4-flash`,
 * `qwen3.5:397b`, `gpt-oss:120b`); the `:cloud` tag is only needed for the local
 * `ollama run` path, not the direct ollama.com API.
 *
 * **Gaps (2026-07-30 tags fetch):** every row’s `details` (family, parameter
 * size, quantization, format) was empty, and `/api/tags` does not include
 * context windows or capability flags. Context + caps below for models that
 * were already in this catalog are **retained from earlier `/api/show` /
 * library reads** for slugs that still appear live — they are NOT re-derived
 * from this tags fetch. Live-only additions (e.g. `kimi-k3`) use conservative
 * defaults (256K, no thinking/vision tags) until a show probe fills them in.
 * Do not invent context windows from tags alone.
 *
 * Only these live cloud slugs are registered here; any other cloud slug still
 * works on the wire (the CLI doesn't gate on the registry) — it just registers
 * lazily via {@link registerOllamaAdHocModel} without a tuned capability table.
 *
 * All models register on the `custom` surface (Ollama's native NDJSON chat
 * protocol is its own wire format, not OpenAI- or Anthropic-shaped).
 *
 * @module llm/providers/ollama/models
 */

import { ollamaCaps } from "./capabilities.ts"
import type { Capabilities } from "./lib/capabilities.ts"
import type { ModelRegistrar, ProviderModelSpec } from "./lib/provider-plugin.ts"
import { makeCharRatioEstimator } from "./lib/token-estimate.ts"
import { PRICING_OLLAMA_GENERIC } from "./pricing.ts"

const M = 1_000_000
const K = 1_000

/**
 * Canonical reasoning-effort levels for Ollama "thinking" models. Ollama's
 * `think` field accepts a boolean or a level string; the agent commonly sends
 * `effort:"high"` (and `"max"` at the top tier), so a thinking model must
 * advertise these to pass capability validation. DeepSeek V4 exposes explicit
 * High/Max reasoning modes; the others accept the level strings and stream a
 * reasoning trace regardless of the exact value.
 */
const THINK_EFFORT = ["low", "medium", "high", "xhigh", "max"] as const

/**
 * Token estimator for Ollama Cloud. The catalog spans many tokenizer families
 * (DeepSeek, Qwen, GLM, Llama-derived gpt-oss). ~3.8 chars/token is a
 * defensible cross-family average, matching the gateway-style estimate other
 * multi-vendor providers use.
 */
const estimateOllamaTokens = makeCharRatioEstimator(3.8)

/** One entry in the built-in Ollama Cloud catalog. */
interface OllamaCatalogEntry {
  id: string
  displayName: string
  capabilities: Capabilities
  tags: string[]
}

/**
 * Compact spec for one Ollama Cloud model, mirroring the ground-truth
 * `/api/show` fields (capabilities flags + context_length). `caps` is Ollama's
 * own capability list; {@link buildEntry} derives the canonical capability table
 * and tags from it so the two never drift. `cheap` flags the small/fast tiers
 * for sub-agent scout recommendation.
 *
 * When `ctx` / `caps` are omitted, the entry uses conservative offline defaults
 * (256K, no thinking/vision) — used for live-only slugs whose tags row lacked
 * capability data.
 */
interface OllamaModelSpec {
  id: string
  name: string
  /** Context window in tokens (from `/api/show` model_info `*.context_length`). */
  ctx?: number
  /** Ollama capability flags. `thinking`/`tools`/`vision`/`audio` are honored. */
  caps?: ReadonlyArray<"thinking" | "tools" | "vision" | "audio">
  cheap?: boolean
  /**
   * When true, ctx/caps were not available from the 2026-07-30 tags fetch and
   * no prior show data exists for this exact slug — conservative defaults apply.
   */
  capsUnknown?: boolean
}

/**
 * The built-in Ollama Cloud catalog — ids from live `/api/tags` (2026-07-30).
 * This is the OFFLINE fallback + the source of capability gating when prior
 * `/api/show` data exists; `ProviderPlugin.listLiveModels` supplements it with
 * whatever the server currently serves.
 */
const CATALOG_SPECS: OllamaModelSpec[] = [
  // DeepSeek V4 — MoE reasoning, tools, text. V4 exposes High/Max modes.
  // (ctx/caps retained from prior /api/show; still live 2026-07-30.)
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    ctx: 1 * M,
    caps: ["thinking", "tools"],
    cheap: true,
  },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", ctx: 512 * K, caps: ["thinking", "tools"] },
  // GLM (Z.ai) — thinking + tools, text.
  { id: "glm-5.2", name: "GLM-5.2", ctx: 1 * M, caps: ["thinking", "tools"] },
  { id: "glm-5.1", name: "GLM-5.1", ctx: 198 * K, caps: ["thinking", "tools"] },
  // Qwen — live slug is the sized tag `qwen3.5:397b` (was bare `qwen3.5`).
  {
    id: "qwen3.5:397b",
    name: "Qwen 3.5 397B",
    ctx: 256 * K,
    caps: ["thinking", "tools", "vision"],
  },
  // MiniMax — M3 multimodal; M2.x text reasoning + tools.
  { id: "minimax-m3", name: "MiniMax M3", ctx: 512 * K, caps: ["thinking", "tools", "vision"] },
  { id: "minimax-m2.7", name: "MiniMax M2.7", ctx: 192 * K, caps: ["thinking", "tools"] },
  { id: "minimax-m2.5", name: "MiniMax M2.5", ctx: 192 * K, caps: ["thinking", "tools"] },
  // Kimi (Moonshot) — native multimodal agentic: vision + thinking + tools.
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    ctx: 256 * K,
    caps: ["thinking", "tools", "vision"],
  },
  { id: "kimi-k2.6", name: "Kimi K2.6", ctx: 256 * K, caps: ["thinking", "tools", "vision"] },
  { id: "kimi-k2.5", name: "Kimi K2.5", ctx: 256 * K, caps: ["thinking", "tools", "vision"] },
  // Live 2026-07-30; tags had empty details — no show-derived ctx/caps yet.
  { id: "kimi-k3", name: "Kimi K3", capsUnknown: true },
  // gpt-oss (OpenAI open-weight) — discrete reasoning levels + tools.
  { id: "gpt-oss:120b", name: "gpt-oss 120B", ctx: 128 * K, caps: ["thinking", "tools"] },
  {
    id: "gpt-oss:20b",
    name: "gpt-oss 20B",
    ctx: 128 * K,
    caps: ["thinking", "tools"],
    cheap: true,
  },
  // Gemma (Google) — live slug is `gemma4:31b` (was bare `gemma4`).
  {
    id: "gemma4:31b",
    name: "Gemma 4 31B",
    ctx: 256 * K,
    caps: ["thinking", "tools", "vision"],
  },
  // NVIDIA Nemotron 3 — reasoning + tools, text.
  { id: "nemotron-3-ultra", name: "Nemotron 3 Ultra", ctx: 256 * K, caps: ["thinking", "tools"] },
  { id: "nemotron-3-super", name: "Nemotron 3 Super", ctx: 256 * K, caps: ["thinking", "tools"] },
  {
    id: "nemotron-3-nano:30b",
    name: "Nemotron 3 Nano 30B",
    ctx: 256 * K,
    caps: ["thinking", "tools"],
    cheap: true,
  },
  // Mistral — live slug is `mistral-large-3:675b` (was bare `mistral-large-3`).
  {
    id: "mistral-large-3:675b",
    name: "Mistral Large 3 675B",
    ctx: 256 * K,
    caps: ["tools", "vision"],
  },
]

/** Derive a full catalog entry (canonical capabilities + tags) from a spec. */
function buildEntry(spec: OllamaModelSpec): OllamaCatalogEntry {
  const capsList = spec.caps ?? []
  const has = (c: string) => capsList.includes(c as never)
  const thinking = has("thinking")
  const contextWindow = spec.ctx ?? 256 * K
  const capabilities = ollamaCaps({
    contextWindow,
    maxOutputTokens: 32 * K,
    // Thinking models accept Ollama's `think` level strings; advertise the
    // canonical effort scale so a common `effort:"high"` request validates.
    ...(thinking ? { effortLevels: THINK_EFFORT } : {}),
    vision: has("vision"),
    audio: has("audio"),
  })
  const tags = ["ollama", "cloud"]
  if (thinking) tags.push("thinking")
  if (has("tools")) tags.push("tools")
  if (has("vision")) tags.push("vision")
  if (has("audio")) tags.push("audio")
  if (spec.cheap) tags.push("cheap")
  if (spec.capsUnknown) tags.push("caps-unknown")
  return {
    id: spec.id,
    displayName: `${spec.name} (Ollama Cloud)`,
    capabilities,
    tags,
  }
}

const CATALOG: OllamaCatalogEntry[] = CATALOG_SPECS.map(buildEntry)

/** Register a single Ollama Cloud model spec into the host registry via ctx. */
export function registerOllamaModelInto(models: ModelRegistrar, entry: OllamaCatalogEntry): string {
  const spec: ProviderModelSpec = {
    id: entry.id,
    providerId: "ollama",
    surfaceId: "custom",
    displayName: entry.displayName,
    tags: entry.tags,
    capabilities: entry.capabilities,
    pricing: PRICING_OLLAMA_GENERIC,
    estimateTokens: estimateOllamaTokens,
    vendorIds: { firstParty: entry.id },
  }
  models.register(spec)
  return entry.id
}

/**
 * Populate the host registry with the representative Ollama Cloud catalog
 * through the setup-context registrar (the `models:register` capability). The
 * first entry is declared the default model a no-model Ollama session boots
 * with. Returns the registered ids.
 */
export function registerOllamaModels(models: ModelRegistrar): string[] {
  const ids = CATALOG.map((entry) => registerOllamaModelInto(models, entry))
  if (ids[0]) models.setDefault(ids[0])
  return ids
}

/**
 * Register a one-off Ollama Cloud slug not in the built-in catalog with a
 * conservative default capability table (256K context, thinking + tools off).
 * Used by the host's ad-hoc model hook so an arbitrary cloud model still works.
 */
export function registerOllamaAdHocModelInto(models: ModelRegistrar, modelId: string): string {
  return registerOllamaModelInto(models, {
    id: modelId,
    displayName: `${modelId} (Ollama Cloud)`,
    capabilities: ollamaCaps({ contextWindow: 256 * K }),
    tags: ["ollama", "cloud"],
  })
}
