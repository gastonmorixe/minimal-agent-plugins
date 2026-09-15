/**
 * The registration core — the keystone that proves the decoupled architecture.
 *
 * This plugin hands a remote {@link Transport} to Intercom WITHOUT either plugin
 * importing the other: it calls `host.transportRegistry.register(transport)` on
 * the host-brokered registry (the `transport:registry` capability). Intercom,
 * separately, calls `transportRegistry.list()` and folds the result into its
 * CompositeTransport. The host is the only thing in the middle, and it treats the
 * transport as opaque (`{ id }`). This mirrors the `ProviderPlugin.register(ctx)`
 * precedent (a provider registers a model adapter into a host registrar; a
 * consumer reads it).
 *
 * Pure + host-agnostic: it takes a {@link PluginHost} and a transport factory, so
 * it's directly unit/e2e testable without a live loader. Idempotent — registering
 * the same id again is last-write-wins in the host store, so calling this on every
 * dispatch is safe.
 *
 * @module lib/register
 */

import type { PluginHost } from "./host-types.ts"
import { RemoteWsTransport, type Transport } from "./transport.ts"

/** Outcome of a registration attempt — a Result, so callers never catch. */
export type RegisterOutcome =
  | { readonly ok: true; readonly transportId: string; readonly alreadyPresent: boolean }
  | { readonly ok: false; readonly reason: string }

/**
 * Register this plugin's remote transport into the host registry.
 *
 * @param host - The capability host (`ctx.host`). Must carry `transportRegistry`
 *   (granted by the `transport:registry` capability). When absent — the host
 *   didn't grant it, or this build of core predates the capability — we return a
 *   clear `ok:false` rather than throwing, so a tool handler degrades gracefully.
 * @param makeTransport - Factory for the transport to register. Defaults to a
 *   {@link RemoteWsTransport} stub. Injectable so tests can register a fake.
 */
export function registerTransport(
  host: PluginHost | undefined,
  makeTransport: () => Transport = () => new RemoteWsTransport(),
): RegisterOutcome {
  const registry = host?.transportRegistry
  if (!registry) {
    return {
      ok: false,
      reason:
        "host.transportRegistry is unavailable — the 'transport:registry' capability is not granted (or this core build predates it)",
    }
  }
  const transport = makeTransport()
  const alreadyPresent = registry.list().some((t) => t.id === transport.id)
  registry.register(transport)
  return { ok: true, transportId: transport.id, alreadyPresent }
}

/** Is this plugin's transport currently registered in the host registry? */
export function isTransportRegistered(host: PluginHost | undefined, id = "cloud-ws"): boolean {
  return host?.transportRegistry?.list().some((t) => t.id === id) ?? false
}
