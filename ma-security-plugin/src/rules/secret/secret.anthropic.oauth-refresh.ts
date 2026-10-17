// Anthropic OAuth refresh token. Harness credential shape (prefix sk-ant-ort01-, 108 chars).
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.anthropic.oauth-refresh",
  family: "secret",
  kind: "anthropic.oauth-refresh",
  severity: "critical",
  gate: "keyword",
  keywords: ["sk-ant-ort01-"],
  pattern: String.raw`(?<![A-Za-z0-9_-])sk-ant-ort01-[A-Za-z0-9_-]{80,200}(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  knownValue: { keys: ["refreshToken"] },
  explain: "Anthropic OAuth refresh token (sk-ant-ort01-). Mints new access tokens for the user.",
  render: { publicPrefix: "sk-ant-ort01-", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: '{"refreshToken": "{{S}}"}',
        secret: { prefix: "sk-ant-ort01-", len: 95, charset: "alnum-_", seed: 301 },
      },
      {
        text: "refresh={{S}}\n",
        secret: { prefix: "sk-ant-ort01-", len: 95, charset: "alnum-_", seed: 302 },
      },
    ],
    not_match: [
      "the sk-ant-ort01- prefix marks an OAuth refresh token",
      { text: "{{S}}", secret: { prefix: "sk-ant-ort01-", len: 79, charset: "alnum", seed: 303 } },
      {
        text: "{{S}}#x",
        secret: { prefix: "sk-ant-ort01-", len: 95, charset: "alnum", seed: 304 },
      },
      { text: "{{S}}", secret: { prefix: "sk-ant-ort02-", len: 95, charset: "alnum", seed: 305 } },
    ],
  },
} satisfies RedactRule
