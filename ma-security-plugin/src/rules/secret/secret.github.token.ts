// GitHub token with a typed prefix: ghp_, gho_, ghu_, ghs_, ghr_. Pattern only in v1
// (no CRC32 checksum check, J open point 2).
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.github.token",
  family: "secret",
  kind: "github.token",
  severity: "critical",
  gate: "keyword",
  keywords: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"],
  pattern: String.raw`(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{36,251}(?=\\?['"\x60]|[\s;,)\]}<>&|@:]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  explain: "GitHub token (ghp_, gho_, ghu_, ghs_, ghr_). Pattern only, no checksum check.",
  render: { keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "GITHUB_TOKEN={{S}}",
        secret: { prefix: "ghp_", len: 36, charset: "alnum", seed: 2401 },
      },
      {
        text: '"token": "{{S}}"',
        secret: { prefix: "gho_", len: 36, charset: "alnum", seed: 2402 },
      },
      {
        text: "https://x-access-token:{{S}}@github.com/org/repo",
        secret: { prefix: "ghs_", len: 36, charset: "alnum", seed: 2403 },
      },
    ],
    not_match: [
      "ghp_ marks a classic personal access token",
      { text: "{{S}}", secret: { prefix: "ghp_", len: 35, charset: "alnum", seed: 2404 } },
      { text: "{{S}}#", secret: { prefix: "ghp_", len: 36, charset: "alnum", seed: 2405 } },
      { text: "{{S}}", secret: { prefix: "ghx_", len: 36, charset: "alnum", seed: 2406 } },
    ],
  },
  inspiredBy: {
    tool: "gitleaks",
    ruleId: "github-pat",
    url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml",
  },
  notes:
    "publicPrefix unset: one rule covers five prefixes and render takes one fixed string. The marker kind names the family.",
} satisfies RedactRule
