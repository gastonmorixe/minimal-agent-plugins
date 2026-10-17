// Catch-all for any other Anthropic key kind: sk-ant-<kind><nn>-. The known kinds have
// their own rules, so this rule skips them with a lookahead.
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.anthropic.prefix",
  family: "secret",
  kind: "anthropic.key",
  severity: "high",
  gate: "keyword",
  keywords: ["sk-ant-"],
  pattern: String.raw`(?<![A-Za-z0-9_-])sk-ant-(?!(?:api03|admin01|oat01|ort01)-)[a-z]{2,12}[0-9]{2}-[A-Za-z0-9_-]{32,250}(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  explain: "Other Anthropic key (sk-ant-<kind><nn>-) not covered by a specific rule.",
  render: { publicPrefix: "sk-ant-", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "KEY={{S}}",
        secret: { prefix: "sk-ant-sid01-", len: 80, charset: "alnum-_", seed: 1901 },
      },
      {
        text: "'{{S}}'",
        secret: { prefix: "sk-ant-api04-", len: 95, charset: "alnum-_", seed: 1902 },
      },
    ],
    not_match: [
      "Anthropic keys share the sk-ant- prefix",
      { text: "{{S}}", secret: { prefix: "sk-ant-sid01-", len: 31, charset: "alnum", seed: 1903 } },
      { text: "{{S}}", secret: { prefix: "sk-ant-sid-", len: 80, charset: "alnum", seed: 1904 } },
      { text: "{{S}}", secret: { prefix: "sk-ant-oat01-", len: 95, charset: "alnum", seed: 1905 } },
    ],
  },
} satisfies RedactRule
