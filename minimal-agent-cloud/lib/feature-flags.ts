/**
 * Feature flags — the surface that will later hold the backend-returned per-user
 * flags (cloud:enabled, teleport:enabled, premium gates, ...).
 *
 * ## How flags flow (designed; stubbed now)
 *
 * In Phase B the cloud plugin logs in (device-authorization grant) and the
 * backend returns the authenticated user's flags. The plugin caches them here and
 * exposes them to OTHER plugins through the transport it registers (a flags getter
 * on the registered object), so a consumer reads flags WITHOUT importing this
 * plugin — same decoupling discipline as the transport itself. No plugin ever
 * imports `minimal-agent-cloud`.
 *
 * For the skeleton everything is hardcoded OFF: `cloudEnabled: false` means "not
 * logged in / no backend", which is the correct default for a connector that
 * hasn't authenticated. Gating consumers must treat absent/false as "no cloud".
 *
 * @module lib/feature-flags
 */

/**
 * The flag set. Open-ended record of named booleans plus a couple of typed
 * headline flags so consumers get autocomplete on the common ones. Unknown flags
 * default to `false` via {@link isEnabled}.
 */
export interface FeatureFlags {
  /** Master switch: is the cloud connector authenticated + active? */
  readonly cloudEnabled: boolean
  /** Teleport (continue a session from web/mobile) available for this user. */
  readonly teleportEnabled: boolean
  /** Remote peers (Intercom peers on other machines) available for this user. */
  readonly remotePeersEnabled: boolean
  /** Any further backend-named flags. */
  readonly [flag: string]: boolean
}

/**
 * The default flags for an UNAUTHENTICATED connector — everything off. This is
 * the skeleton's value and also the correct fallback whenever the backend is
 * unreachable or login hasn't happened.
 */
export const DEFAULT_FLAGS: FeatureFlags = Object.freeze({
  cloudEnabled: false,
  teleportEnabled: false,
  remotePeersEnabled: false,
})

/**
 * Read the current feature flags. STUB: always returns {@link DEFAULT_FLAGS}
 * (cloudEnabled:false). When auth lands, this reads the cached backend response,
 * falling back to DEFAULT_FLAGS when not logged in / offline.
 */
export function currentFlags(): FeatureFlags {
  return DEFAULT_FLAGS
}

/** True when a named flag is on. Unknown / absent flags are `false`. */
export function isEnabled(flags: FeatureFlags, name: string): boolean {
  return flags[name] === true
}
