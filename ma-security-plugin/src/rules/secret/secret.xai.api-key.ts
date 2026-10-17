// xAI (Grok) API key.
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.xai.api-key",
  family: "secret",
  kind: "xai.api-key",
  severity: "critical",
  gate: "keyword",
  keywords: ["xai-"],
  pattern: String.raw`(?<![A-Za-z0-9_-])xai-[A-Za-z0-9_-]{70,120}(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  explain: "xAI (Grok) API key (xai-).",
  render: { publicPrefix: "xai-", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "XAI_API_KEY={{S}}",
        secret: { prefix: "xai-", len: 80, charset: "alnum", seed: 2201 },
      },
      { text: "'{{S}}'", secret: { prefix: "xai-", len: 80, charset: "alnum", seed: 2202 } },
    ],
    not_match: [
      "the xai-sdk package and xai-grok-2 model names",
      { text: "{{S}}", secret: { prefix: "xai-", len: 69, charset: "alnum", seed: 2203 } },
      { text: "{{S}}#", secret: { prefix: "xai-", len: 80, charset: "alnum", seed: 2204 } },
      { text: "{{S}}", secret: { prefix: "xai_", len: 80, charset: "alnum", seed: 2205 } },
    ],
  },
  inspiredBy: {
    tool: "betterleaks",
    ruleId: "xai-api-key",
    url: "https://github.com/betterleaks/betterleaks/blob/main/config/betterleaks.toml",
  },
} satisfies RedactRule
