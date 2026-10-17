// Wafer API key. Harness credential shape (prefix wfr_, 68 chars).
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.wafer.api-key",
  family: "secret",
  kind: "wafer.api-key",
  severity: "critical",
  gate: "keyword",
  keywords: ["wfr_"],
  pattern: String.raw`(?<![A-Za-z0-9_-])wfr_[A-Za-z0-9_-]{32,128}(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  knownValue: { keys: ["apiKey"] },
  explain: "Wafer API key (wfr_).",
  render: { publicPrefix: "wfr_", keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "WAFER_API_KEY={{S}}",
        secret: { prefix: "wfr_", len: 64, charset: "alnum", seed: 701 },
      },
      {
        text: '"apiKey": "{{S}}"',
        secret: { prefix: "wfr_", len: 64, charset: "alnum", seed: 702 },
      },
    ],
    not_match: [
      "the wfr_ prefix marks a Wafer key",
      { text: "{{S}}", secret: { prefix: "wfr_", len: 31, charset: "alnum", seed: 703 } },
      { text: "{{S}}#", secret: { prefix: "wfr_", len: 64, charset: "alnum", seed: 704 } },
      { text: "{{S}}", secret: { prefix: "xwfr_", len: 64, charset: "alnum", seed: 705 } },
    ],
  },
} satisfies RedactRule
