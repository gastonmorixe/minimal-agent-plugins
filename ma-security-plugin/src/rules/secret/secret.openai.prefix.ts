// Catch-all for OpenAI keys with a typed prefix but no T3BlbkFJ marker (newer formats).
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.openai.prefix",
  family: "secret",
  kind: "openai.key",
  severity: "high",
  gate: "keyword",
  // B4-fix m2: sk-None- is the legacy user key form with no project.
  keywords: ["sk-proj-", "sk-admin-", "sk-svcacct-", "sk-none-"],
  pattern: String.raw`(?<![A-Za-z0-9_-])sk-(?:proj|admin|svcacct|None)-[A-Za-z0-9_-]{40,250}(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  explain:
    "Other OpenAI key (sk-proj-, sk-admin-, sk-svcacct-, sk-None-) not caught by a specific rule.",
  render: { publicPrefix: "sk-", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "OPENAI_API_KEY={{S}}",
        secret: { prefix: "sk-proj-", len: 120, charset: "alnum-_", seed: 2101 },
      },
      { text: "'{{S}}'", secret: { prefix: "sk-admin-", len: 64, charset: "alnum-_", seed: 2102 } },
      {
        text: "key={{S}}",
        secret: { prefix: "sk-None-", len: 48, charset: "alnum-_", seed: 2106 },
      },
    ],
    not_match: [
      "sk-proj- keys belong to one project",
      { text: "{{S}}", secret: { prefix: "sk-proj-", len: 39, charset: "alnum", seed: 2103 } },
      { text: "{{S}}#", secret: { prefix: "sk-proj-", len: 120, charset: "alnum", seed: 2104 } },
      { text: "{{S}}", secret: { prefix: "sk-team-", len: 120, charset: "alnum", seed: 2105 } },
    ],
  },
  notes:
    "Overlaps openai.api-key and openai.svcacct by design. The merge keeps one span (longest, then lower id).",
} satisfies RedactRule
