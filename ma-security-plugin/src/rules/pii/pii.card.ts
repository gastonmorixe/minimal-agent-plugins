// Payment card number. Luhn required. Groups of 4 with one space or dash, or a plain run.
import type { RedactRule } from "../types.ts"

export default {
  id: "pii.card",
  family: "pii",
  kind: "card",
  severity: "high",
  gate: "digit-run",
  keywords: [],
  // Not inside a longer digit or word run. Known issuer first digits 2 to 6. 13 to 19
  // digits total. Grouped form: 4-4-4-1..7 with one shared separator.
  pattern: String.raw`(?<![A-Za-z0-9_.+-])(?:[2-6][0-9]{3}([ -])[0-9]{4}\1[0-9]{4}\1[0-9]{1,7}|[2-6][0-9]{12,18})(?![A-Za-z0-9_]|[.-][A-Za-z0-9]| [0-9])`,
  flags: "",
  validator: "luhn",
  explain: "Payment card number (13 to 19 digits, issuer prefix 2 to 6, Luhn checked).",
  render: {},
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "card: {{S}} exp 12/30",
        secret: { prefix: "4000 0000 0000 ", len: 4, charset: "hex", seed: 3064 },
      },
      {
        text: "pan={{S}}",
        secret: { prefix: "5500-0000-0000-", len: 4, charset: "hex", seed: 3189 },
      },
      {
        text: '"number":"{{S}}"',
        secret: { prefix: "340000000000", len: 3, charset: "hex", seed: 3131 },
      },
    ],
    not_match: [
      "order 1234567890123 shipped",
      "version 4000.0000.0000.0002",
      "uuid 4000-0000-0000-0002-ffff",
      // Right shape, bad Luhn digit.
      {
        text: "card {{S}}",
        secret: { prefix: "4000 0000 0000 ", len: 4, charset: "hex", seed: 3020 },
      },
    ],
  },
  notes:
    "gate digit-run: no literal keyword exists for card numbers. The engine runs this rule only on texts with a 13+ digit run (separators allowed).",
} satisfies RedactRule
