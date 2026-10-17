// Anthropic API key (sk-ant-api03-, 93 random chars, then "AA").
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.anthropic.api-key",
  family: "secret",
  kind: "anthropic.api-key",
  severity: "critical",
  gate: "keyword",
  keywords: ["sk-ant-api03-"],
  pattern: String.raw`(?<![A-Za-z0-9_-])sk-ant-api03-[A-Za-z0-9_-]{93}AA(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  explain: "Anthropic API key (sk-ant-api03-).",
  render: { publicPrefix: "sk-ant-api03-", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "ANTHROPIC_API_KEY={{S}}",
        secret: { prefix: "sk-ant-api03-", len: 93, charset: "alnum-_", suffix: "AA", seed: 1701 },
      },
      {
        text: "'{{S}}'",
        secret: { prefix: "sk-ant-api03-", len: 93, charset: "alnum-_", suffix: "AA", seed: 1702 },
      },
    ],
    not_match: [
      "keys start with sk-ant-api03-",
      {
        text: "{{S}}",
        secret: { prefix: "sk-ant-api03-", len: 92, charset: "alnum", suffix: "AA", seed: 1703 },
      },
      {
        text: "{{S}}",
        secret: { prefix: "sk-ant-api03-", len: 93, charset: "alnum", suffix: "AB", seed: 1704 },
      },
    ],
  },
  inspiredBy: {
    tool: "gitleaks",
    ruleId: "anthropic-api-key",
    url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml",
  },
} satisfies RedactRule
