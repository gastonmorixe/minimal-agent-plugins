// Meta Llama API key. Harness credential shape (prefix LLM_, 48 chars).
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.meta.api-key",
  family: "secret",
  kind: "meta.api-key",
  severity: "critical",
  gate: "keyword",
  keywords: ["llm_"],
  // B4-fix m1: the body must hold a digit (LLM_ constant and mixed-case names do not),
  // and may run to 64 chars.
  pattern: String.raw`(?<![A-Za-z0-9_-])LLM_(?=[A-Za-z_-]{0,63}[0-9])[A-Za-z0-9_-]{40,64}(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  knownValue: { keys: ["apiKey"] },
  // LLM_ also starts config constant names. Random keys have high entropy, names do not.
  entropy: { min: 4.2, charset: "b64" },
  explain: "Meta Llama API key (LLM_, about 48 chars). Entropy check skips LLM_ constant names.",
  render: { publicPrefix: "LLM_", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "META_API_KEY={{S}}",
        secret: { prefix: "LLM_", len: 44, charset: "alnum", seed: 801 },
      },
      {
        text: '"apiKey": "{{S}}"',
        secret: { prefix: "LLM_", len: 44, charset: "alnum", seed: 802 },
      },
    ],
    not_match: [
      "LLM_PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS_FOR_STREAMS=1",
      // B4-fix m1: mixed-case identifier, no digit.
      "LLM_ProviderAnthropicClaudeOpusFiveContextWindowLimitX",
      { text: "{{S}}", secret: { prefix: "LLM_", len: 39, charset: "alnum", seed: 803 } },
      { text: "{{S}}#", secret: { prefix: "LLM_", len: 44, charset: "alnum", seed: 804 } },
      // Hex body: right shape, low entropy. Fails the entropy check.
      { text: "{{S}}", secret: { prefix: "LLM_", len: 44, charset: "hex", seed: 805 } },
    ],
  },
} satisfies RedactRule
