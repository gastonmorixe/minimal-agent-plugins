// Anthropic OAuth access token. Harness credential shape (prefix sk-ant-oat01-, 108 chars).
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.anthropic.oauth-access",
  family: "secret",
  kind: "anthropic.oauth-access",
  severity: "critical",
  gate: "keyword",
  keywords: ["sk-ant-oat01-"],
  pattern: String.raw`(?<![A-Za-z0-9_-])sk-ant-oat01-[A-Za-z0-9_-]{80,200}(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  knownValue: { keys: ["accessToken"] },
  explain: "Anthropic OAuth access token (sk-ant-oat01-). Acts as the signed-in Claude user.",
  render: { publicPrefix: "sk-ant-oat01-", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: '{"accessToken": "{{S}}"}',
        secret: { prefix: "sk-ant-oat01-", len: 95, charset: "alnum-_", seed: 201 },
      },
      {
        text: "export ANTHROPIC_TOKEN={{S}}",
        secret: { prefix: "sk-ant-oat01-", len: 95, charset: "alnum-_", seed: 202 },
      },
    ],
    not_match: [
      "the sk-ant-oat01- prefix marks an OAuth access token",
      { text: "{{S}}", secret: { prefix: "sk-ant-oat01-", len: 79, charset: "alnum", seed: 203 } },
      {
        text: "{{S}}#x",
        secret: { prefix: "sk-ant-oat01-", len: 95, charset: "alnum", seed: 204 },
      },
      { text: "{{S}}", secret: { prefix: "sk-ant-oat02-", len: 95, charset: "alnum", seed: 205 } },
    ],
  },
} satisfies RedactRule
