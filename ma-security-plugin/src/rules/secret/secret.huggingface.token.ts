// Hugging Face access token. Harness credential shape (prefix hf_, 37 chars).
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.huggingface.token",
  family: "secret",
  kind: "huggingface.token",
  severity: "critical",
  gate: "keyword",
  keywords: ["hf_"],
  pattern: String.raw`(?<![A-Za-z0-9_-])hf_[A-Za-z0-9]{30,40}(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  knownValue: { keys: ["apiKey"] },
  explain: "Hugging Face access token (hf_).",
  render: { publicPrefix: "hf_", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      { text: "HF_TOKEN={{S}}", secret: { prefix: "hf_", len: 34, charset: "alnum", seed: 1001 } },
      {
        text: '"apiKey": "{{S}}"',
        secret: { prefix: "hf_", len: 34, charset: "alnum", seed: 1002 },
      },
    ],
    not_match: [
      "from huggingface_hub import hf_hub_download",
      { text: "{{S}}", secret: { prefix: "hf_", len: 29, charset: "alnum", seed: 1003 } },
      { text: "{{S}}#", secret: { prefix: "hf_", len: 34, charset: "alnum", seed: 1004 } },
      { text: "{{S}}", secret: { prefix: "hf_", len: 41, charset: "alnum", seed: 1005 } },
    ],
  },
  inspiredBy: {
    tool: "gitleaks",
    ruleId: "huggingface-access-token",
    url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml",
  },
} satisfies RedactRule
