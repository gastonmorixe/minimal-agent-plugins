// GitHub fine-grained personal access token (github_pat_, 82 chars after the prefix).
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.github.fine-grained-pat",
  family: "secret",
  kind: "github.fine-grained-pat",
  severity: "critical",
  gate: "keyword",
  keywords: ["github_pat_"],
  pattern: String.raw`(?<![A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{82,120}(?=\\?['"\x60]|[\s;,)\]}<>&|@:]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  explain: "GitHub fine-grained personal access token (github_pat_).",
  render: { publicPrefix: "github_pat_", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "GH_TOKEN={{S}}",
        secret: { prefix: "github_pat_", len: 82, charset: "alnum", seed: 2501 },
      },
    ],
    not_match: [
      "fine-grained tokens start with github_pat_",
      { text: "{{S}}", secret: { prefix: "github_pat_", len: 81, charset: "alnum", seed: 2502 } },
      { text: "{{S}}#", secret: { prefix: "github_pat_", len: 82, charset: "alnum", seed: 2503 } },
      { text: "{{S}}", secret: { prefix: "github_pac_", len: 82, charset: "alnum", seed: 2504 } },
    ],
  },
  inspiredBy: {
    tool: "gitleaks",
    ruleId: "github-fine-grained-pat",
    url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml",
  },
} satisfies RedactRule
