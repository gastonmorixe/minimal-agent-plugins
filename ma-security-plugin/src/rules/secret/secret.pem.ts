// PEM private key block. Real newlines or JSON-escaped "\n" line breaks. BEGIN and END
// lines stay visible at low and mid (render.pem).
import type { RedactRule } from "../types.ts"

const BEGIN = "-----BEGIN PRIVATE KEY-----"
const END = "-----END PRIVATE KEY-----"

export default {
  id: "secret.pem",
  family: "secret",
  kind: "pem",
  severity: "critical",
  gate: "keyword",
  keywords: ["-----begin"],
  // BEGIN line, then lines: a real line break or an escaped \\n (JSON) and one base64 run.
  // Each repeat starts with a char the run cannot hold, so a body splits one way only.
  // B4-fix M1: a real-newline line may hold spaces and tabs (an indented YAML "|" block,
  // k8s, Helm), so the indent before each line and before -----END sits in the run.
  // B4-fix M2: legacy encrypted PEM. Optional Proc-Type and DEK-Info header lines after
  // BEGIN. The blank line after them is an empty run.
  pattern: String.raw`-----BEGIN[ A-Z0-9]{0,40}PRIVATE KEY(?:-----| BLOCK-----)(?:[\r\n][ \t]{0,16}Proc-Type: [^\r\n]{1,64})?(?:[\r\n][ \t]{0,16}DEK-Info: [^\r\n]{1,100})?(?:[\r\n][ \tA-Za-z0-9+/=]{0,144}|\\[A-Za-z0-9+/=]{1,130}){1,800}-----END[ A-Z0-9]{0,40}PRIVATE KEY(?:-----| BLOCK-----)`,
  flags: "",
  explain: "PEM private key block (RSA, EC, OPENSSH, PKCS8). BEGIN and END lines stay visible.",
  render: { pem: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "key file:\n{{S}}\n",
        secret: { prefix: `${BEGIN}\n`, len: 64, charset: "alnum", suffix: `\n${END}`, seed: 1201 },
      },
      {
        text: '{"private_key": "{{S}}\\n"}',
        secret: {
          prefix: `${BEGIN}\\n`,
          len: 64,
          charset: "alnum",
          suffix: `\\n${END}`,
          seed: 1202,
        },
      },
    ],
    not_match: [
      `${BEGIN}\n...\n${END}`,
      {
        text: "{{S}}",
        secret: { prefix: `${BEGIN}\n`, len: 64, charset: "alnum", suffix: "\n", seed: 1203 },
      },
      {
        text: "{{S}}",
        secret: {
          prefix: "-----BEGIN PUBLIC KEY-----\n",
          len: 64,
          charset: "alnum",
          suffix: "\n-----END PUBLIC KEY-----",
          seed: 1204,
        },
      },
    ],
  },
  inspiredBy: {
    tool: "gitleaks",
    ruleId: "private-key",
    url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml",
  },
  notes:
    "Legacy encrypted PEM with Proc-Type and DEK-Info header lines is not matched in v1. Its body is ciphertext.",
} satisfies RedactRule
