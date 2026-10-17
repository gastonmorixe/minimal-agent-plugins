// Google API key (AIza, 39 chars).
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.google.api-key",
  family: "secret",
  kind: "google.api-key",
  severity: "high",
  gate: "keyword",
  keywords: ["aiza"],
  pattern: String.raw`(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  explain: "Google API key (AIza). Bills the owner's Google Cloud project.",
  render: { publicPrefix: "AIza", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "GOOGLE_API_KEY={{S}}",
        secret: { prefix: "AIza", len: 35, charset: "alnum-_", seed: 2901 },
      },
      { text: "?key={{S}}&q=1", secret: { prefix: "AIza", len: 35, charset: "alnum", seed: 2902 } },
    ],
    not_match: [
      "Google keys start with AIza",
      { text: "{{S}}", secret: { prefix: "AIza", len: 34, charset: "alnum", seed: 2903 } },
      { text: "{{S}}", secret: { prefix: "AIza", len: 36, charset: "alnum", seed: 2904 } },
      { text: "{{S}}", secret: { prefix: "AIzb", len: 35, charset: "alnum", seed: 2905 } },
    ],
  },
  inspiredBy: {
    tool: "gitleaks",
    ruleId: "gcp-api-key",
    url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml",
  },
} satisfies RedactRule
