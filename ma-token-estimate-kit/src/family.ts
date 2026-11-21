/**
 * Model id to tokenizer family map, and the estimators for each family.
 *
 * A provider plugin calls {@link estimatorForModelId} (or
 * {@link familyForModelId} and then {@link estimatorForFamily}) to set
 * `ModelEntry.estimateTokens`. The weights come from `presets.ts`.
 *
 * @module family
 */

import {
  makeCharClassEstimator,
  type TokenEstimator,
} from "@minimal-agent/core/plugin-api/llm/token-estimate"

import { TOKENIZER_PRESETS, type TokenizerFamily } from "./presets.ts"

/**
 * Aggregator and router prefixes. The map removes them before it reads the
 * model name. The match is case-insensitive. The map removes them again
 * until no prefix agrees.
 */
const AGGREGATOR_PREFIXES: readonly string[] = [
  "openrouter/",
  "accounts/fireworks/models/",
  "fireworks/",
  "together/",
  "cline-pass/",
  "opencode/",
  "opencode-go/",
  "opencode-zen/",
]

/**
 * Vendor (org) prefixes. When the model name agrees with no name rule, the
 * org gives the family. Anthropic is not here: a Claude family needs the
 * version from the name.
 */
const ORG_FAMILY: Readonly<Record<string, TokenizerFamily>> = {
  openai: "openai-o200k",
  google: "gemma",
  "meta-llama": "llama3",
  qwen: "qwen",
  deepseek: "deepseek",
  "deepseek-ai": "deepseek",
  mistralai: "mistral",
  "z-ai": "glm",
  "zai-org": "glm",
  thudm: "glm",
  moonshotai: "kimi",
  minimax: "minimax",
  minimaxai: "minimax",
  "x-ai": "grok",
  xai: "grok",
}

/**
 * Claude family from the version in the name. Claude 4.7 and later (all
 * 5.x) use the new tokenizer: about 1.3x more tokens for the same text.
 * `claude-opus-4-5-20251101` is 4.5. `claude-sonnet-4-20250514` is 4.0 (a
 * date is not a minor version). Also the old order `claude-3-5-sonnet`.
 */
function claudeFamily(name: string): TokenizerFamily {
  const m = /^claude-(?:[a-z]+-)?(\d+)(?:[-.](\d{1,2})(?!\d))?/.exec(name)
  if (!m) return "claude-5x"
  const major = Number(m[1])
  const minor = m[2] === undefined ? 0 : Number(m[2])
  if (major > 4 || (major === 4 && minor >= 7)) return "claude-5x"
  return "claude-legacy"
}

/** Name rules. The first rule that agrees wins. `name` is lowercase. */
function familyForName(name: string): TokenizerFamily | undefined {
  if (name.startsWith("claude-")) return claudeFamily(name)
  // OpenAI: gpt-oss and gpt-4o and later use o200k. Plain gpt-4 and gpt-3.5 use cl100k.
  if (/^gpt-3\.5|^gpt-4(?:-|$)(?!o)/.test(name)) return "openai-cl100k"
  if (/^(?:gpt-|chatgpt-|codex-|o[1-9](?:-|$))/.test(name)) return "openai-o200k"
  if (/^(?:gemini|gemma)/.test(name)) return "gemma"
  if (/^muse-/.test(name)) return "meta-muse"
  const llama = /(?:^|[-_])llama-?v?(\d)/.exec(name)
  if (llama) return llama[1] === "4" ? "llama4" : "llama3"
  if (/^(?:qwen|qwq)/.test(name)) return "qwen"
  if (name.startsWith("deepseek")) return "deepseek"
  if (/^(?:mistral|devstral|codestral|magistral|ministral|mixtral|pixtral)/.test(name)) {
    return "mistral"
  }
  if (/^(?:glm|chatglm)/.test(name)) return "glm"
  if (/^(?:kimi|moonshot)/.test(name)) return "kimi"
  if (name.startsWith("minimax")) return "minimax"
  if (name.startsWith("grok")) return "grok"
  return undefined
}

/**
 * Get the tokenizer family of a model id.
 *
 * Steps:
 * 1. Lowercase the id. Remove aggregator prefixes (`openrouter/`,
 *    `accounts/fireworks/models/`, `cline-pass/`, ...).
 * 2. Split `org/name` at the last `/`. A Hugging Face cache name
 *    `org--name` also splits. Remove an Ollama tag (`:120b`).
 * 3. Remove a `cursor-` prefix when the rest agrees with a rule
 *    (`cursor-grok-4.5-high-fast` is grok).
 * 4. Name rules: `claude-*` (4.7 and later: `claude-5x`, else
 *    `claude-legacy`), `gpt-*`/`o1`/`o3`/`o4`/`gpt-oss` (o200k; `gpt-4`,
 *    `gpt-3.5`: cl100k), `gemini*`/`gemma*`, `llama-3*`/`llama-4*`,
 *    `muse-*`, `qwen*`, `deepseek*`, `mistral*`/`devstral*`/`codestral*`,
 *    `glm*`, `kimi*`, `minimax*`, `grok*`.
 * 5. Else the org: `openai`, `google`, `meta-llama`, `qwen`,
 *    `deepseek(-ai)`, `mistralai`, `z-ai`/`zai-org`, `moonshotai`,
 *    `minimax(ai)`, `x-ai`.
 *
 * @param modelId - The model id as the provider gives it.
 * @returns The family, or `undefined` when no rule agrees (for example `cursor-auto`).
 */
export function familyForModelId(modelId: string): TokenizerFamily | undefined {
  let id = modelId.trim().toLowerCase()
  for (let changed = true; changed; ) {
    changed = false
    for (const prefix of AGGREGATOR_PREFIXES) {
      if (id.startsWith(prefix)) {
        id = id.slice(prefix.length)
        changed = true
      }
    }
  }
  let org = ""
  let name = id
  const slash = id.lastIndexOf("/")
  if (slash >= 0) {
    org = id.slice(0, slash)
    name = id.slice(slash + 1)
  } else {
    const dashes = id.indexOf("--")
    if (dashes > 0) {
      org = id.slice(0, dashes)
      name = id.slice(dashes + 2)
    }
  }
  const colon = name.indexOf(":")
  if (colon > 0) name = name.slice(0, colon)
  const byName =
    familyForName(name) ??
    (name.startsWith("cursor-") ? familyForName(name.slice("cursor-".length)) : undefined)
  if (byName) return byName
  const orgLast = org.slice(org.lastIndexOf("/") + 1)
  return ORG_FAMILY[orgLast]
}

const estimatorCache = new Map<TokenizerFamily, TokenEstimator>()

/**
 * Get the estimator of a family. The result is memoized: each call for one
 * family gives the same function.
 */
export function estimatorForFamily(family: TokenizerFamily): TokenEstimator {
  let estimator = estimatorCache.get(family)
  if (!estimator) {
    estimator = makeCharClassEstimator(TOKENIZER_PRESETS[family])
    estimatorCache.set(family, estimator)
  }
  return estimator
}

/**
 * Get the estimator of a model id.
 *
 * @param modelId - The model id as the provider gives it.
 * @param fallbackFamily - The family to use when no rule agrees. For an
 *   unknown open-weight model, `"generic"` is a good choice.
 * @returns The memoized estimator, or `undefined` when no rule agrees and
 *   there is no fallback (core then shows no count).
 */
export function estimatorForModelId(
  modelId: string,
  fallbackFamily?: TokenizerFamily,
): TokenEstimator | undefined {
  const family = familyForModelId(modelId) ?? fallbackFamily
  return family === undefined ? undefined : estimatorForFamily(family)
}
