// Anthropic Admin API key (sk-ant-admin01-, 93 random chars, then "AA").
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.anthropic.admin-key",
  family: "secret",
  kind: "anthropic.admin-key",
  severity: "critical",
  gate: "keyword",
  keywords: ["sk-ant-admin01-"],
  pattern: String.raw`(?<![A-Za-z0-9_-])sk-ant-admin01-[A-Za-z0-9_-]{93}AA(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  explain: "Anthropic Admin API key (sk-ant-admin01-). Manages the organization.",
  render: { publicPrefix: "sk-ant-admin01-", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "ADMIN_KEY={{S}}",
        secret: {
          prefix: "sk-ant-admin01-",
          len: 93,
          charset: "alnum-_",
          suffix: "AA",
          seed: 1801,
        },
      },
    ],
    not_match: [
      "admin keys start with sk-ant-admin01-",
      {
        text: "{{S}}",
        secret: { prefix: "sk-ant-admin01-", len: 92, charset: "alnum", suffix: "AA", seed: 1803 },
      },
      {
        text: "{{S}}",
        secret: { prefix: "sk-ant-admin01-", len: 93, charset: "alnum", suffix: "AB", seed: 1804 },
      },
    ],
  },
  inspiredBy: {
    tool: "gitleaks",
    ruleId: "anthropic-admin-api-key",
    url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml",
  },
} satisfies RedactRule
