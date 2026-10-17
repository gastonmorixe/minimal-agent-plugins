// Generic secret assignment: password=, api_key:, token: and peers. The key name stays
// visible. Only the value (group 1) is replaced.
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.generic.kv",
  family: "secret",
  kind: "generic.kv",
  severity: "medium",
  gate: "keyword",
  keywords: [
    "pass",
    "pwd",
    "secret",
    "token",
    "api_key",
    "api-key",
    "apikey",
    "credential",
    "auth",
  ],
  // Key: a word that ends in a secret word (db_password, client_secret, GH_TOKEN). Then
  // an optional closing quote, an assignment operator, an optional opening quote, and
  // the value. B4-fix m3: the value must hold a digit, and either 2+ digits or 24+ chars,
  // so identifiers like createAuthHandler_v2 do not match. B4-fix BLOCKER: no
  // "[REDACTED:" lookbehind (the model controls the text, D16). A real marker ends in
  // ":<8 hex>]", so the value may not be exactly 8 hex then "]", and "]" is not an end
  // delimiter. See the tag note in src/redact/markers.ts.
  pattern: String.raw`(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]{0,40}(?:passwd|password|passphrase|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth)["']?[ \t]{0,4}(?::=|=>|[:=])[ \t]{0,4}["'\x60]?(?![0-9a-f]{8}\])(?=[^\s"'\x60]{0,150}[0-9])(?=[A-Za-z0-9_+\/=.~-]{24}|[^\s"'\x60\d]{0,150}\d[^\s"'\x60\d]{0,150}\d)([A-Za-z0-9_+\/=.~-]{8,150})(?=\\?['"\x60]|[\s;,)}<>&|]|\\[nr]|$)`,
  flags: "i",
  group: 1,
  entropy: { min: 3, charset: "b64" },
  explain:
    "Value assigned to a password, secret, token, or API key name. The key name stays visible.",
  allow: ["placeholder", "gitleaks-global", "stopwords"],
  allowStopwords: true,
  render: {},
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      { text: "DB_PASSWORD={{S}}", secret: { len: 18, charset: "alnum", suffix: "9", seed: 1601 } },
      {
        text: 'client_secret: "{{S}}"',
        secret: { len: 32, charset: "alnum-_", suffix: "1", seed: 1602 },
      },
      { text: "api_key = '{{S}}'", secret: { len: 24, charset: "hex", suffix: "a", seed: 1603 } },
    ],
    not_match: [
      "password=${DB_PASSWORD}",
      "token: <your-token-here>",
      "api_key = your_api_key_1",
      "the password is stored safely",
      "secret_ref: true",
      // B4-fix m3: an identifier with one digit and under 24 chars.
      "auth=createAuthHandler_v2",
      // Low entropy value: fails the entropy check.
      "auth_token=aaaa1111aaaa1111",
    ],
  },
  inspiredBy: {
    tool: "gitleaks",
    ruleId: "generic-api-key",
    url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml",
  },
  notes:
    "Leading [A-Za-z0-9_.-]{0,40} is greedy and anchored by a lookbehind, not the lazy upstream prefix.",
} satisfies RedactRule
