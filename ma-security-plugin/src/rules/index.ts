// The registry index. Hand-listed, sorted by id. The only import point for rules.
// Add a rule: create src/rules/<family>/<id>.ts with one default export, import it
// here, and insert it in the family array in id order. The completeness test checks
// both directions.
import piiCard from "./pii/pii.card.ts"
import piiEmail from "./pii/pii.email.ts"
import piiHarnessIdentity from "./pii/pii.harness-identity.ts"
import secretAnthropicAdminKey from "./secret/secret.anthropic.admin-key.ts"
import secretAnthropicApiKey from "./secret/secret.anthropic.api-key.ts"
import secretAnthropicOauthAccess from "./secret/secret.anthropic.oauth-access.ts"
import secretAnthropicOauthRefresh from "./secret/secret.anthropic.oauth-refresh.ts"
import secretAnthropicPrefix from "./secret/secret.anthropic.prefix.ts"
import secretAwsAccessKeyId from "./secret/secret.aws.access-key-id.ts"
import secretGenericJwt from "./secret/secret.generic.jwt.ts"
import secretGenericKv from "./secret/secret.generic.kv.ts"
import secretGenericUrlCred from "./secret/secret.generic.url-cred.ts"
import secretGithubFineGrainedPat from "./secret/secret.github.fine-grained-pat.ts"
import secretGithubToken from "./secret/secret.github.token.ts"
import secretGitlabPat from "./secret/secret.gitlab.pat.ts"
import secretGoogleApiKey from "./secret/secret.google.api-key.ts"
import secretHttpAuthHeader from "./secret/secret.http.auth-header.ts"
import secretHuggingfaceToken from "./secret/secret.huggingface.token.ts"
import secretKnownValueHarness from "./secret/secret.known-value.harness.ts"
import secretMetaApiKey from "./secret/secret.meta.api-key.ts"
import secretOpenaiApiKey from "./secret/secret.openai.api-key.ts"
import secretOpenaiPrefix from "./secret/secret.openai.prefix.ts"
import secretOpenaiSvcacct from "./secret/secret.openai.svcacct.ts"
import secretOpencodeApiKey from "./secret/secret.opencode.api-key.ts"
import secretOpenrouterApiKey from "./secret/secret.openrouter.api-key.ts"
import secretPem from "./secret/secret.pem.ts"
import secretSlackToken from "./secret/secret.slack.token.ts"
import secretStripeKey from "./secret/secret.stripe.key.ts"
import secretWaferApiKey from "./secret/secret.wafer.api-key.ts"
import secretXaiApiKey from "./secret/secret.xai.api-key.ts"
import type { CmdRule, PathRule, RedactRule } from "./types.ts"

export const REDACT_RULES: readonly RedactRule[] = [
  piiCard,
  piiEmail,
  piiHarnessIdentity,
  secretAnthropicAdminKey,
  secretAnthropicApiKey,
  secretAnthropicOauthAccess,
  secretAnthropicOauthRefresh,
  secretAnthropicPrefix,
  secretAwsAccessKeyId,
  secretGenericJwt,
  secretGenericKv,
  secretGenericUrlCred,
  secretGithubFineGrainedPat,
  secretGithubToken,
  secretGitlabPat,
  secretGoogleApiKey,
  secretHttpAuthHeader,
  secretHuggingfaceToken,
  secretKnownValueHarness,
  secretMetaApiKey,
  secretOpenaiApiKey,
  secretOpenaiPrefix,
  secretOpenaiSvcacct,
  secretOpencodeApiKey,
  secretOpenrouterApiKey,
  secretPem,
  secretSlackToken,
  secretStripeKey,
  secretWaferApiKey,
  secretXaiApiKey,
]

export const PATH_RULES: readonly PathRule[] = []

export const CMD_RULES: readonly CmdRule[] = []

/** Old id to new id. A hit gives a one-time notice. No alias equals a live id. */
export const ALIASES: Readonly<Record<string, string>> = {}

/**
 * Every rule id in the index. The hook wiring passes this set to
 * resolvePolicy as `knownIds`, so a config clause on a rule-pack id resolves
 * instead of being dropped as an unknown target (D14). Never hardcode ids
 * elsewhere.
 */
export const RULE_IDS: ReadonlySet<string> = new Set([
  ...REDACT_RULES.map((r) => r.id),
  ...PATH_RULES.map((r) => r.id),
  ...CMD_RULES.map((r) => r.id),
])
