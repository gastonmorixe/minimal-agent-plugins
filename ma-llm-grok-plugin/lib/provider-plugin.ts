/**
 * Provider SDK contract, widened with:
 * - `ProviderSessionContext.credentialName` / `.authKind` (stored-credential
 *   selection when this provider has more than one `auth.jsonc` entry).
 * - `OAuthCredentialRefreshContext.signal` (cancellation for an in-flight
 *   OAuth token refresh).
 *
 * `@minimal-agent/core`'s published `provider-plugin` does not expose these
 * (S42 finding, reported upstream in the plugins-repo de-vendoring change:
 * the old vendored copy of this module had them, core's current leaf
 * contract does not). `session-info.ts` / `oauth-login.ts` need them.
 * Everything else in this module is the real host export, re-exported
 * unchanged; the local interfaces below shadow the star-exported ones.
 *
 * @module lib/provider-plugin
 */

export * from "@minimal-agent/core/plugin-api/llm/provider-plugin"

import type {
  OAuthCredentialRefreshContext as HostOAuthCredentialRefreshContext,
  ProviderSessionContext as HostProviderSessionContext,
} from "@minimal-agent/core/plugin-api/llm/provider-plugin"

/** Host `ProviderSessionContext`, plus this provider's stored-credential selectors. */
export interface ProviderSessionContext extends HostProviderSessionContext {
  /**
   * Stored credential display name (`--credential-name` / config) when the
   * provider has multiple auth.jsonc entries. Prime paths that read the
   * store directly should select this entry instead of the first match.
   */
  credentialName?: string
  /**
   * Resolved session auth kind. When `"oauth"`, prime must not fall back to
   * an env API key; when `"api-key"`, it must not use a stored OAuth token.
   */
  authKind?: "api-key" | "oauth"
}

/** Host `OAuthCredentialRefreshContext`, plus a cancellation signal. */
export interface OAuthCredentialRefreshContext extends HostOAuthCredentialRefreshContext {
  /** Optional abort signal when the host wants to cancel a stuck refresh. */
  signal?: AbortSignal
}
