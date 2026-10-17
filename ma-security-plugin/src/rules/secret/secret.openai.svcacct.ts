// OpenAI service account key. Harness credential shape (prefix sk-svcacct-, 167 chars).
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.openai.svcacct",
  family: "secret",
  kind: "openai.svcacct",
  severity: "critical",
  gate: "keyword",
  keywords: ["sk-svcacct-"],
  pattern: String.raw`(?<![A-Za-z0-9_-])sk-svcacct-[A-Za-z0-9_-]{40,250}(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  knownValue: { keys: ["apiKey"] },
  explain: "OpenAI service account API key (sk-svcacct-).",
  render: { publicPrefix: "sk-svcacct-", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "OPENAI_API_KEY={{S}}",
        secret: { prefix: "sk-svcacct-", len: 156, charset: "alnum-_", seed: 501 },
      },
      {
        text: '{"apiKey":"{{S}}"}',
        secret: { prefix: "sk-svcacct-", len: 156, charset: "alnum-_", seed: 502 },
      },
    ],
    not_match: [
      "keys that start with sk-svcacct- belong to a service account",
      { text: "{{S}}", secret: { prefix: "sk-svcacct-", len: 39, charset: "alnum", seed: 503 } },
      { text: "{{S}}#", secret: { prefix: "sk-svcacct-", len: 156, charset: "alnum", seed: 504 } },
      { text: "{{S}}", secret: { prefix: "sk-svcacc-", len: 156, charset: "alnum", seed: 505 } },
    ],
  },
} satisfies RedactRule
