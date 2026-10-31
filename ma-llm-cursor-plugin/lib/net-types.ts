/**
 * Network-client contract, widened with Cursor's Connect-bidi streaming
 * knobs (`keepRequestOpen`, `writeRequestBody`, `endRequestBody`).
 *
 * `@minimal-agent/core`'s published `net/types` does not expose these (S42
 * finding, reported upstream in the plugins-repo de-vendoring change: the old
 * vendored copy of this module had them, core's current leaf contract does
 * not). Cursor's HTTP/2 bidirectional MCP-over-wire feature
 * (`connect/bidi-wire.ts`, `bidi-run.ts`) needs a request stream that stays
 * writable after the initial body write. Everything else in this module is
 * the real host type, re-exported unchanged.
 *
 * @module lib/net-types
 */

import type {
  NetworkClient as HostNetworkClient,
  NetworkRequest as HostNetworkRequest,
  NetworkResponse as HostNetworkResponse,
} from "@minimal-agent/core/plugin-api/net/types"

export type {
  NetworkCaptureOptions,
  NetworkMethod,
  NetworkProtocol,
  NetworkTransportInfo,
} from "@minimal-agent/core/plugin-api/net/types"

/** Host `NetworkRequest`, plus the Connect-bidi request-stream knob. */
export interface NetworkRequest extends HostNetworkRequest {
  /**
   * When true, keep the HTTP/2 request stream writable after the initial `body`
   * write (Connect bidi). Follow-up frames use {@link NetworkResponse.writeRequestBody}.
   */
  keepRequestOpen?: boolean
}

/**
 * The argument shape for {@link NetworkClient.request}: a {@link NetworkRequest}
 * minus the host-assigned `id` / `transportHint` (the host fills those in). An
 * `id` may be supplied to correlate logs but is optional.
 */
export type NetworkRequestInput = Omit<NetworkRequest, "id" | "transportHint"> & {
  id?: string
}

/** Host `NetworkResponse`, plus the Connect-bidi follow-up-frame writers. */
export interface NetworkResponse extends HostNetworkResponse {
  /** Write more bytes on an open HTTP/2 request stream (Connect bidi). */
  writeRequestBody?(chunk: Uint8Array): void
  /** Half-close the HTTP/2 request stream. */
  endRequestBody?(): void
}

/** Host `NetworkClient`, re-typed over the widened request/response shapes. */
export interface NetworkClient extends Omit<HostNetworkClient, "request"> {
  /** Fire one request through the host's transport stack. */
  request(input: NetworkRequestInput): Promise<NetworkResponse>
}
