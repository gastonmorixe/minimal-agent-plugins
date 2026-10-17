// OpenAI API key with the T3BlbkFJ marker: project and admin keys, plus the legacy
// sk-<20>T3BlbkFJ<20> form. Service account keys have their own rule.
import type { RedactRule } from "../types.ts"

// Gen adds random chars only at the end, so the head before the marker is fixed filler.
const PROJ_HEAD = `sk-proj-${"Qx7_".repeat(18)}QxT3BlbkFJ`
const LEGACY_HEAD = `sk-${"Qx72".repeat(5)}T3BlbkFJ`

export default {
  id: "secret.openai.api-key",
  family: "secret",
  kind: "openai.api-key",
  severity: "critical",
  gate: "keyword",
  keywords: ["t3blbkfj"],
  pattern: String.raw`(?<![A-Za-z0-9_-])sk-(?:(?:proj|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  explain: "OpenAI API key with the T3BlbkFJ marker (sk-proj-, sk-admin-, legacy sk-).",
  render: { publicPrefix: "sk-", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "OPENAI_API_KEY={{S}}",
        secret: { prefix: PROJ_HEAD, len: 74, charset: "alnum-_", seed: 2001 },
      },
      {
        text: '"key": "{{S}}"',
        secret: { prefix: LEGACY_HEAD, len: 20, charset: "alnum", seed: 2002 },
      },
    ],
    not_match: [
      "OpenAI keys hide T3BlbkFJ in the middle",
      { text: "{{S}}", secret: { prefix: "sk-proj-", len: 120, charset: "alnum", seed: 2003 } },
      { text: "{{S}}", secret: { prefix: LEGACY_HEAD, len: 19, charset: "alnum", seed: 2004 } },
      { text: "{{S}}#", secret: { prefix: PROJ_HEAD, len: 74, charset: "alnum", seed: 2005 } },
    ],
  },
  inspiredBy: {
    tool: "gitleaks",
    ruleId: "openai-api-key",
    url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml",
  },
} satisfies RedactRule
