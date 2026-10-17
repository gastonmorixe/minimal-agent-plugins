// OpenRouter API key. Harness credential shape (prefix sk-or-v1-, 73 chars).
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.openrouter.api-key",
  family: "secret",
  kind: "openrouter.api-key",
  severity: "critical",
  gate: "keyword",
  keywords: ["sk-or-v1-"],
  pattern: String.raw`(?<![A-Za-z0-9_-])sk-or-v1-[A-Za-z0-9_-]{32,128}(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  knownValue: { keys: ["apiKey"] },
  explain: "OpenRouter API key (sk-or-v1-).",
  render: { publicPrefix: "sk-or-v1-", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "OPENROUTER_API_KEY={{S}}",
        secret: { prefix: "sk-or-v1-", len: 64, charset: "hex", seed: 601 },
      },
      { text: "'{{S}}'", secret: { prefix: "sk-or-v1-", len: 64, charset: "hex", seed: 602 } },
    ],
    not_match: [
      "OpenRouter keys use the sk-or-v1- prefix",
      { text: "{{S}}", secret: { prefix: "sk-or-v1-", len: 31, charset: "hex", seed: 603 } },
      { text: "{{S}}#", secret: { prefix: "sk-or-v1-", len: 64, charset: "hex", seed: 604 } },
      { text: "{{S}}", secret: { prefix: "sk-or-v2-", len: 64, charset: "hex", seed: 605 } },
    ],
  },
} satisfies RedactRule
