/**
 * Embedded read-only credential for pulling obscura binaries from the private
 * `obscura-dist` release repo.
 *
 * This is INTENTIONALLY committed: the token travels with the plugin so any
 * copy (including an account-less user's) can install obscura. It is a
 * fine-grained PAT scoped to ONLY the `gastonmorixe/obscura-dist` repository
 * with `Contents: read-only`. A leak grants nothing but pulling the
 * already-distributed binaries. Rotate by replacing this value and cutting a
 * new plugin release.
 *
 * Empty string ⇒ no embedded credential; the host falls back to the user's own
 * GitHub token (only works on a machine where they're logged in). Set the real
 * value after creating the PAT (see the plugin README → "obscura provisioning").
 */
export const OBSCURA_DIST_TOKEN =
  "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"
