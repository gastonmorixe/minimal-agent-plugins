/**
 * ACP extension negotiation (layer L3), agent side. The contract is
 * `docs/acp-extensions.md` (sections 2 and 3). Studio runs the same
 * algorithm and the same test vectors (contract section 7.4).
 *
 * Each side advertises `{version, features}` under the capability key
 * `minimal-agent/ext` in its capability `_meta` (ACP extensibility,
 * "Advertising custom capabilities"). The effective set is computed once,
 * at `initialize`, and does not change for the life of the connection.
 *
 * Pure. No I/O. Never throws.
 *
 * @module ext
 */

/** The extension namespace. `_meta` keys are `<NS>/<name>`, methods `_<NS>/<name>`. */
export const EXT_NAMESPACE = "minimal-agent"

/** The capability key in `agentCapabilities._meta` / `clientCapabilities._meta`. */
export const EXT_CAPABILITY_KEY = `${EXT_NAMESPACE}/ext`

/** The contract version this side implements. */
export const EXT_VERSION = 1

/** The L3 features this side ships now. List a feature only when its code is shipped. */
export const EXT_LOCAL_FEATURES: readonly string[] = ["usage", "structuredOutput", "sampling"]

/** Feature names defined for each contract version (contract section 5). */
const DEFINED_FEATURES: Readonly<Record<number, readonly string[]>> = {
  1: ["usage", "structuredOutput", "sampling"],
}

/** One side's advertised value, and also the shape of the effective result. */
export interface ExtAdvert {
  readonly version: number
  readonly features: readonly string[]
}

/** No L3 with the peer: version 0 and no features. */
export const NO_EXT: ExtAdvert = Object.freeze({ version: 0, features: Object.freeze([]) })

/**
 * This side's advertised value, as sent in the `initialize` result.
 * `supported` (optional) filters {@link EXT_LOCAL_FEATURES}: a feature is
 * listed only when `supported(feature)` is true, so the agent advertises a
 * feature only when its runtime can apply it (contract section 4 rule 7).
 * No filter: the full set.
 */
export function localExt(supported?: (feature: string) => boolean): ExtAdvert {
  const features = supported ? EXT_LOCAL_FEATURES.filter(supported) : [...EXT_LOCAL_FEATURES]
  return { version: EXT_VERSION, features }
}

/** The value as a valid advert, or `undefined` when it is malformed. */
function parseAdvert(value: unknown): ExtAdvert | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const { version, features } = value as { version?: unknown; features?: unknown }
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return undefined
  if (!Array.isArray(features)) return undefined
  if (!features.every((f) => typeof f === "string")) return undefined
  return { version, features: features as string[] }
}

/**
 * The effective `{version, features}` for a connection (contract section 2.3).
 * Peer absent or malformed: {@link NO_EXT}. Version = the lower of the two.
 * Features = the intersection, minus names not defined for that version.
 * Never throws.
 */
export function effectiveFeatures(local: unknown, peer: unknown): ExtAdvert {
  try {
    const l = parseAdvert(local)
    const p = parseAdvert(peer)
    if (!l || !p) return NO_EXT
    const version = Math.min(l.version, p.version)
    const defined = DEFINED_FEATURES[version]
    // This side cannot speak the effective version.
    if (!defined) return NO_EXT
    const peerSet = new Set(p.features)
    const features = [...new Set(l.features)].filter((f) => peerSet.has(f) && defined.includes(f))
    return { version, features }
  } catch {
    return NO_EXT
  }
}

/** The peer advert at `capabilities._meta["minimal-agent/ext"]`, or `undefined`. Never throws. */
export function readPeerExt(capabilities: unknown): unknown {
  if (typeof capabilities !== "object" || capabilities === null) return undefined
  const meta = (capabilities as { _meta?: unknown })._meta
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined
  return (meta as Record<string, unknown>)[EXT_CAPABILITY_KEY]
}

/** True when `feature` is in the effective set. */
export function hasExtFeature(effective: ExtAdvert, feature: string): boolean {
  return effective.features.includes(feature)
}
