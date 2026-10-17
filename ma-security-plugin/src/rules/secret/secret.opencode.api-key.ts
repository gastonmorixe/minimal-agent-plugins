// OpenCode API key. Harness credential shape (prefix oc_sk_, 51 chars).
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.opencode.api-key",
  family: "secret",
  kind: "opencode.api-key",
  severity: "critical",
  gate: "keyword",
  keywords: ["oc_sk_"],
  pattern: String.raw`(?<![A-Za-z0-9_-])oc_sk_[A-Za-z0-9_-]{32,96}(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  knownValue: { keys: ["apiKey"] },
  explain: "OpenCode API key (oc_sk_).",
  render: { publicPrefix: "oc_sk_", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "OPENCODE_API_KEY={{S}}",
        secret: { prefix: "oc_sk_", len: 45, charset: "alnum", seed: 901 },
      },
      {
        text: '"apiKey": "{{S}}"',
        secret: { prefix: "oc_sk_", len: 45, charset: "alnum", seed: 902 },
      },
    ],
    not_match: [
      "OpenCode keys start with oc_sk_",
      { text: "{{S}}", secret: { prefix: "oc_sk_", len: 31, charset: "alnum", seed: 903 } },
      { text: "{{S}}#", secret: { prefix: "oc_sk_", len: 45, charset: "alnum", seed: 904 } },
      { text: "{{S}}", secret: { prefix: "oc_pk_", len: 45, charset: "alnum", seed: 905 } },
    ],
  },
} satisfies RedactRule
