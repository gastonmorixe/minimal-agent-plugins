// Email address. Level low keeps a hint (ja[...]@ex[...]le.com#tag).
import type { RedactRule } from "../types.ts"

export default {
  id: "pii.email",
  family: "pii",
  kind: "email",
  severity: "low",
  gate: "always",
  keywords: [],
  // Start guard: not inside a longer local part, and not the password of a URL
  // authority (url-cred owns that span). Skip noreply senders. The domain ends at a
  // 2+ letter TLD that is not followed by more label chars.
  pattern: String.raw`(?<![A-Za-z0-9._%+-])(?<!\/\/[^\s\/@]{0,128})(?!no-?reply@)[A-Za-z0-9._%+-]{1,64}@(?!users\.noreply\.github\.com(?![A-Za-z0-9.-]))[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,6}\.[A-Za-z]{2,24}(?![A-Za-z0-9-]|\.[A-Za-z0-9])`,
  flags: "i",
  explain: "Email address. Low level keeps the first chars and the domain shape.",
  render: {},
  defaults: { status: "on", level: "low" },
  examples: {
    match: [
      {
        text: "contact jane.doe@example.com for access",
        secret: { len: 0, charset: "alnum", prefix: "jane.doe@example.com", seed: 1 },
      },
      {
        text: "From: John Smith <{{S}}>",
        secret: {
          prefix: "john.smith+",
          len: 6,
          charset: "alnum",
          suffix: "@mail.example.org",
          seed: 1501,
        },
      },
    ],
    not_match: [
      "send to noreply@example.com",
      "commits by 1234+jane@users.noreply.github.com",
      "postgres://jane:secret@db.example.com/app",
      "jane.doe at example dot com",
      "the @ sign and user@localhost",
    ],
  },
  notes:
    "gate always: the only literal is @ (1 char). The start lookbehind rejects mid-run starts in O(1).",
} satisfies RedactRule
