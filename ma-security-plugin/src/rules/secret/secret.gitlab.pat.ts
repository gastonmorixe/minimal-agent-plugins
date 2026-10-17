// GitLab personal access token (glpat-).
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.gitlab.pat",
  family: "secret",
  kind: "gitlab.pat",
  severity: "critical",
  gate: "keyword",
  keywords: ["glpat-"],
  pattern: String.raw`(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,100}(?=\\?['"\x60]|[\s;,)\]}<>&|@:]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  explain: "GitLab personal access token (glpat-).",
  render: { publicPrefix: "glpat-", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "GITLAB_TOKEN={{S}}",
        secret: { prefix: "glpat-", len: 20, charset: "alnum-_", seed: 2601 },
      },
      {
        text: "PRIVATE-TOKEN header value {{S}} here",
        secret: { prefix: "glpat-", len: 51, charset: "alnum", seed: 2602 },
      },
    ],
    not_match: [
      "GitLab tokens begin with glpat-",
      { text: "{{S}}", secret: { prefix: "glpat-", len: 19, charset: "alnum", seed: 2603 } },
      { text: "{{S}}#", secret: { prefix: "glpat-", len: 20, charset: "alnum", seed: 2604 } },
      { text: "{{S}}", secret: { prefix: "glpat_", len: 20, charset: "alnum", seed: 2605 } },
    ],
  },
  inspiredBy: {
    tool: "gitleaks",
    ruleId: "gitlab-pat",
    url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml",
  },
} satisfies RedactRule
