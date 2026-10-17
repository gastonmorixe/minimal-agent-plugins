// HTTP auth header value. The header name and scheme stay outside group 1, so they stay
// visible at every level that keeps public parts.
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.http.auth-header",
  family: "secret",
  kind: "http.auth-header",
  severity: "high",
  gate: "keyword",
  keywords: ["authorization", "api-key", "auth-token", "private-token"],
  pattern: String.raw`(?:authorization["']?[ \t]{0,4}[:=][ \t]{0,4}["']?(?:bearer|basic|token|apikey|api-key)[ \t]{1,4}|(?:x-api-key|api-key|x-auth-token|private-token)["']?[ \t]{0,4}[:=][ \t]{0,4}["']?)(?![0-9a-f]{8}\])([A-Za-z0-9_.=+/~-]{8,1024})(?=\\?['"\x60]|[\s;,)}<>&|]|\\[nr]|$)`,
  flags: "i",
  group: 1,
  // B4-fix: no "[REDACTED:" lookbehind (the model controls the text, D16). A real marker
  // ends in ":<8 hex>]", so the value may not be exactly 8 hex then "]". "]" is not an
  // end delimiter. See the tag note in src/redact/markers.ts.
  explain:
    "Credential in an Authorization, x-api-key, or similar HTTP header. Header name stays visible.",
  allow: ["placeholder", "gitleaks-global"],
  render: {},
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "curl -H 'Authorization: Bearer {{S}}' https://api.example.com",
        secret: { len: 40, charset: "alnum-_", seed: 1301 },
      },
      {
        text: '{"headers": {"x-api-key": "{{S}}"}}',
        secret: { len: 32, charset: "alnum", seed: 1302 },
      },
      {
        text: "Authorization: Basic {{S}}\r\n",
        secret: { len: 28, charset: "alnum", suffix: "=", seed: 1303 },
      },
    ],
    not_match: [
      'curl -H "Authorization: Bearer $TOKEN" https://api.example.com',
      "Authorization: Bearer <token>",
      "the Authorization header carries a bearer token",
      { text: "Authorization: Bearer {{S}}", secret: { len: 7, charset: "alnum", seed: 1304 } },
      { text: "Authorization: Bearer {{S}}#x", secret: { len: 40, charset: "alnum", seed: 1305 } },
    ],
  },
  inspiredBy: {
    tool: "gitleaks",
    ruleId: "curl-auth-header",
    url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml",
  },
} satisfies RedactRule
