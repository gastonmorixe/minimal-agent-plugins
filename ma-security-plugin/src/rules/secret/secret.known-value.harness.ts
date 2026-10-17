// Known-value only rule: every secret value in the harness credential file and env.
// No pattern. The known-value index (B6) owns detection. This file gives the layer an
// id, a level, a SecurityStatus row, and an off switch (J section 6, open point 1).
import type { RedactRule } from "../types.ts"

export default {
  id: "secret.known-value.harness",
  family: "secret",
  kind: "known-value.harness",
  severity: "critical",
  gate: "always",
  keywords: [],
  knownValue: { keys: ["accessToken", "refreshToken", "idToken", "apiKey", "api_key"] },
  explain: "A secret value read from the harness credential file or a secret env var. Exact match.",
  render: {},
  defaults: { status: "on", level: "mid" },
  examples: { match: [], not_match: [] },
  notes: "Known-value only. Values under 8 chars are skipped by the index floor.",
} satisfies RedactRule
