// Stripe secret and restricted keys, live, test and prod.
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.stripe.key",
  family: "secret",
  kind: "stripe.key",
  severity: "critical",
  gate: "keyword",
  keywords: ["sk_live_", "sk_test_", "sk_prod_", "rk_live_", "rk_test_", "rk_prod_"],
  pattern: String.raw`(?<![A-Za-z0-9_-])[sr]k_(?:live|test|prod)_[A-Za-z0-9]{20,247}(?=\\?['"\x60]|[\s;,)\]}<>&|]|\\[nr]|\.(?![A-Za-z0-9_-])|$)`,
  flags: "",
  explain: "Stripe secret or restricted key (sk_live_, rk_live_, test and prod forms).",
  render: { keepTail: true },
  defaults: { status: "on", level: "mid" },
  examples: {
    match: [
      {
        text: "STRIPE_SECRET_KEY={{S}}",
        secret: { prefix: "sk_live_", len: 99, charset: "alnum", seed: 2801 },
      },
      { text: "'{{S}}'", secret: { prefix: "rk_test_", len: 24, charset: "alnum", seed: 2802 } },
    ],
    not_match: [
      "publishable keys start with pk_live_ and are public",
      { text: "{{S}}", secret: { prefix: "sk_live_", len: 19, charset: "alnum", seed: 2803 } },
      { text: "{{S}}#", secret: { prefix: "sk_live_", len: 24, charset: "alnum", seed: 2804 } },
      { text: "{{S}}", secret: { prefix: "pk_live_", len: 24, charset: "alnum", seed: 2805 } },
    ],
  },
  inspiredBy: {
    tool: "gitleaks",
    ruleId: "stripe-access-token",
    url: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml",
  },
  notes: "publicPrefix unset: six prefixes in one rule.",
} satisfies RedactRule
