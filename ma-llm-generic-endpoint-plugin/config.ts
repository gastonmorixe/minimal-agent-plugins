/** Runtime config for the generic endpoint provider. */

export interface GenericEndpointConfig {
  endpoint: string
  format: string
  providerModel?: string
  /** Effort ladder the ad-hoc model advertises (from --effort-levels). */
  effortLevels?: string[]
}

function clean(v: string | undefined): string | undefined {
  const trimmed = v?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Read the generic-endpoint runtime config from environment variables.
 *
 * Requires an endpoint and a format (surface id); throws with actionable
 * guidance when either is missing. Optional provider model and effort-level
 * ladder are included only when set.
 */
export function readGenericEndpointConfig(
  env: Record<string, string | undefined> = process.env,
): GenericEndpointConfig {
  const endpoint = clean(env.MINIMAL_AGENT_ENDPOINT)
  if (!endpoint) throw new Error("generic-endpoint: missing --endpoint or MINIMAL_AGENT_ENDPOINT")
  const format = clean(env.MINIMAL_AGENT_FORMAT) ?? clean(env.MINIMAL_AGENT_SURFACE)
  if (!format) throw new Error("generic-endpoint: missing --format or MINIMAL_AGENT_FORMAT")
  const levelsRaw = clean(env.MINIMAL_AGENT_EFFORT_LEVELS)
  const effortLevels = levelsRaw
    ? levelsRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined
  return {
    endpoint,
    format,
    ...(clean(env.MINIMAL_AGENT_PROVIDER_MODEL)
      ? { providerModel: clean(env.MINIMAL_AGENT_PROVIDER_MODEL) }
      : {}),
    ...(effortLevels && effortLevels.length > 0 ? { effortLevels } : {}),
  }
}

/**
 * Normalize a user-supplied endpoint URL to the codec's expected path.
 *
 * Strips trailing slashes and appends `defaultPath` unless the endpoint
 * already ends with it, so both bare hosts and full paths resolve correctly.
 */
export function normalizeEndpoint(endpoint: string, defaultPath: string): string {
  const trimmed = endpoint.trim()
  if (!trimmed) throw new Error("generic-endpoint: endpoint is empty")
  const path = defaultPath.startsWith("/") ? defaultPath : `/${defaultPath}`
  const withoutTrailing = trimmed.replace(/\/+$/, "")
  if (withoutTrailing.endsWith(path)) return withoutTrailing
  return `${withoutTrailing}${path}`
}
