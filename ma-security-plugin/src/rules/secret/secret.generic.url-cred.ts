// Password in a URL authority, scheme://user:pass@host. Only the password is group 2,
// so the scheme, user and host stay visible.
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.generic.url-cred",
  family: "secret",
  kind: "generic.url-cred",
  severity: "high",
  gate: "keyword",
  keywords: ["://"],
  pattern: String.raw`(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{1,20}):\/\/[^\s:@\/?#'"\x60<>\[\]]{1,128}:([^\s@\/?#'"\x60<>\[\]]{3,256})@(?=[A-Za-z0-9\[])`,
  flags: "i",
  group: 2,
  explain:
    "Password inside a URL (scheme://user:password@host). Scheme, user and host stay visible.",
  allow: ["placeholder", "gitleaks-global"],
  render: {},
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "DATABASE_URL=postgres://jane:{{S}}@db.example.com:5432/app",
        secret: { len: 20, charset: "alnum", seed: 1401 },
      },
      {
        text: "git clone https://jane.doe:{{S}}@git.example.com/org/repo.git",
        secret: { len: 24, charset: "alnum-_", seed: 1402 },
      },
    ],
    not_match: [
      "postgres://jane:${DB_PASS}@db.example.com/app",
      "redis://jane:changeme@localhost:6379",
      "see https://example.com/docs and git@github.com:org/repo",
      { text: "ftp://jane:{{S}}@host", secret: { len: 2, charset: "alnum", seed: 1403 } },
    ],
  },
} satisfies RedactRule
