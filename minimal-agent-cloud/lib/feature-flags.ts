/**
 * Feature flags — the per-user gate set, now token-aware.
 *
 * ## How flags flow
 *
 * Once the device-grant login (`lib/auth.ts`) persists a bearer token
 * (`lib/token-store.ts`), the connector is "logged in". The flag set is then a
 * function of that token:
 *   - NO token  → {@link DEFAULT_FLAGS} (everything off — not logged in).
 *   - token     → fetch the user's flags from the backend (TODO: real endpoint),
 *                 falling back to {@link LOGGED_IN_DEFAULT_FLAGS} (cloud on) until
 *                 the backend flags route exists.
 *
 * The fetch is behind a clean injectable function so the GATING LOGIC is real
 * even while the flag SOURCE is stubbed: a consumer asks `currentFlags(env)` and
 * gets a correct cloudEnabled today, and the only change when Mike ships the
 * endpoint is the body of `fetchBackendFlags`.
 *
 * Other plugins read flags through the transport the connector registers, never
 * by importing this plugin (same decoupling as the transport itself).
 *
 * @module lib/feature-flags
 */

import { hasAuth, loadAuth } from "./token-store.ts"

/** The GraphQL query for the authenticated viewer's flags (contract v1, Mike). */
const ME_FLAGS_QUERY =
  "query { me { flags { cloudEnabled teleportEnabled remotePeersEnabled all } } }"

/**
 * The flag set. Open-ended record of named booleans plus typed headline flags so
 * consumers get autocomplete on the common ones. Unknown flags default to `false`
 * via {@link isEnabled}.
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

/** Default flags for an UNAUTHENTICATED connector — everything off. */
export const DEFAULT_FLAGS: FeatureFlags = Object.freeze({
  cloudEnabled: false,
  teleportEnabled: false,
  remotePeersEnabled: false,
})

/**
 * Default flags for a LOGGED-IN connector, used until the backend flags endpoint
 * exists. Cloud + remote peers on; teleport on (it's the flagship). Premium gates
 * stay off until the real endpoint reports entitlements.
 */
export const LOGGED_IN_DEFAULT_FLAGS: FeatureFlags = Object.freeze({
  cloudEnabled: true,
  teleportEnabled: true,
  remotePeersEnabled: true,
})

/**
 * Fetch the authenticated user's flags from the backend's GraphQL `me { flags }`
 * (contract v1, Mike). REAL call: POST the query to `graphqlUrl` with
 * `Authorization: Bearer <device-token>`, map `me.flags` onto {@link FeatureFlags}.
 *
 * Resilient (the skill's degrade-don't-crash rule): no token ⇒ DEFAULT_FLAGS
 * (logged out); any network/GraphQL error ⇒ LOGGED_IN_DEFAULT_FLAGS (we HAVE a
 * token, so cloud is on; we just couldn't refresh the exact entitlements). The
 * backend's v1 returns all-true for any authed user, and the real Stripe-plan
 * gating swaps in behind this exact shape with no change here.
 *
 * `io.fetch` is injected so this is testable without a network.
 */
export async function fetchBackendFlags(
  graphqlUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  io: { fetch: typeof fetch } = { fetch },
): Promise<FeatureFlags> {
  const auth = loadAuth(env)
  if (!auth) return DEFAULT_FLAGS
  try {
    const res = await io.fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth.accessToken}`,
      },
      body: JSON.stringify({ query: ME_FLAGS_QUERY }),
    })
    if (!res.ok) return LOGGED_IN_DEFAULT_FLAGS
    const body = (await res.json()) as {
      data?: { me?: { flags?: Partial<FeatureFlags> & { all?: Record<string, boolean> } } | null }
    }
    const flags = body.data?.me?.flags
    if (!flags) return LOGGED_IN_DEFAULT_FLAGS // token present but viewer null/no flags
    // Merge the open-ended `all` bag first, then the named typed fields win.
    return Object.freeze({
      ...(flags.all && typeof flags.all === "object" ? flags.all : {}),
      cloudEnabled: flags.cloudEnabled ?? true,
      teleportEnabled: flags.teleportEnabled ?? true,
      remotePeersEnabled: flags.remotePeersEnabled ?? true,
    }) as FeatureFlags
  } catch {
    return LOGGED_IN_DEFAULT_FLAGS // have a token, couldn't reach backend
  }
}

/**
 * The synchronous, best-effort current flags — derived purely from whether a
 * token is on disk. Used by the status surface + gating where an async fetch is
 * overkill. `cloudEnabled` is the real gate: true iff logged in.
 */
export function currentFlags(env: NodeJS.ProcessEnv = process.env): FeatureFlags {
  return hasAuth(env) ? LOGGED_IN_DEFAULT_FLAGS : DEFAULT_FLAGS
}

/** True when a named flag is on. Unknown / absent flags are `false`. */
export function isEnabled(flags: FeatureFlags, name: string): boolean {
  return flags[name] === true
}
