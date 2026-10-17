// AWS access key id. Four-letter type prefix, then 16 base32 chars.
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.aws.access-key-id",
  family: "secret",
  kind: "aws.access-key-id",
  severity: "high",
  gate: "keyword",
  keywords: ["akia", "asia", "abia", "acca", "a3t"],
  pattern: String.raw`(?<![A-Za-z0-9])(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}(?![A-Za-z0-9])`,
  flags: "",
  explain: "AWS access key id (AKIA, ASIA and peers). Pairs with a secret access key.",
  render: { keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "aws_access_key_id = {{S}}",
        secret: { prefix: "AKIA", len: 16, charset: "upper-digit", seed: 2313 },
      },
      {
        text: '"AccessKeyId": "{{S}}"',
        secret: { prefix: "ASIA", len: 16, charset: "upper-digit", seed: 2318 },
      },
    ],
    not_match: [
      "AKIA is the prefix of a long term key id",
      { text: "{{S}}", secret: { prefix: "AKIA", len: 15, charset: "upper-digit", seed: 2320 } },
      { text: "{{S}}", secret: { prefix: "AKIA", len: 17, charset: "upper-digit", seed: 2320 } },
      { text: "{{S}}", secret: { prefix: "AKIB", len: 16, charset: "upper-digit", seed: 2313 } },
    ],
  },
  inspiredBy: {
    tool: "gitleaks",
    ruleId: "aws-access-token",
    url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml",
  },
  notes:
    "No publicPrefix: the key id is an identifier, the prefix alone tells the key type. keepTail only at low.",
} satisfies RedactRule
