// Signed JSON Web Token. Covers harness OAuth access, id and refresh tokens of ChatGPT,
// Cursor, Grok and Cline. Header and payload are JSON objects, so both start "eyJ".
import type { RedactRule } from "../types.ts"

// Synthetic header {"alg":"HS256","typ":"JWT"} and payload {"sub":"jane.doe","iss":"corp.example"}.
// Kept as two parts so this file never holds a whole token shape.
const HEADER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
const PAYLOAD = "eyJzdWIiOiJqYW5lLmRvZSIsImlzcyI6ImNvcnAuZXhhbXBsZSJ9"
const SIGNED = `${HEADER}.${PAYLOAD}.`

export default {
  id: "secret.generic.jwt",
  family: "secret",
  kind: "generic.jwt",
  severity: "high",
  gate: "keyword",
  keywords: ["eyj"],
  pattern: String.raw`(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,1000}\.eyJ[A-Za-z0-9_-]{8,8000}\.[A-Za-z0-9_-]{16,1000}(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  validator: "jwt-shape",
  explain: "Signed JWT (header.payload.signature). Often an OAuth access, id or refresh token.",
  render: {},
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: '{"access_token": "{{S}}"}',
        secret: { prefix: SIGNED, len: 43, charset: "b64url", seed: 401 },
      },
      {
        text: "id token {{S}} expires soon",
        secret: { prefix: SIGNED, len: 86, charset: "b64url", seed: 402 },
      },
    ],
    not_match: [
      "a JWT starts with eyJ and has three parts",
      { text: "{{S}}", secret: { prefix: SIGNED, len: 15, charset: "b64url", seed: 403 } },
      // Shape match, but header and payload do not decode to JSON: fails jwt-shape.
      {
        text: "{{S}}.eyJ{{S}}.{{S}}",
        secret: { prefix: "eyJ", len: 24, charset: "alnum", seed: 404 },
      },
    ],
  },
  inspiredBy: {
    tool: "gitleaks",
    ruleId: "jwt",
    url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml",
  },
  notes:
    "reviewed:huge-bound: OAuth id token payloads pass 1024 chars. Each part is one flat class run, no nesting. Bench gate covers it.",
} satisfies RedactRule
