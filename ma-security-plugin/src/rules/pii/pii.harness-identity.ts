// Known-value only rule: identity values (emails, names, account and org ids) in the
// harness credential file. No pattern. The known-value index (B6) owns detection.
import type { RedactRule } from "../types.ts"

export default {
  id: "pii.harness-identity",
  family: "pii",
  kind: "harness-identity",
  severity: "low",
  gate: "always",
  keywords: [],
  knownValue: {
    keys: [
      "email",
      "emailAddress",
      "displayName",
      "userFullName",
      "firstName",
      "lastName",
      "givenName",
      "familyName",
      "accountUuid",
      "organizationUuid",
      "accountId",
      "userId",
      "teamId",
      "workosId",
      "principalId",
      "authId",
    ],
  },
  explain: "An identity value (email, name, account or org id) from the harness credential file.",
  render: {},
  defaults: { status: "on", level: "low" },
  examples: { match: [], not_match: [] },
  notes: "Known-value only. Values under 8 chars are skipped on purpose (SPEC-v3 defaults matrix).",
} satisfies RedactRule
