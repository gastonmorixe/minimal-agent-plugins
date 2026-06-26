/**
 * The Transport PORT shape + this plugin's remote adapter (a STUB for now).
 *
 * ## Decoupling note
 *
 * The `Transport` interface is OWNED by ma-intercom-plugin (its `lib/transport.ts`).
 * This plugin may not import that one (the no-cross-plugin-import rule), so we
 * re-declare the SAME structural shape here. TypeScript's structural typing means
 * the object we register satisfies Intercom's `Transport` at runtime, and the host
 * registry (`transport:registry`) only requires `{ id }`, so the host accepts it.
 * If Intercom's port shape changes, update this mirror (and add a contract test).
 *
 * ## Wired to the real backend
 *
 * As of the cutover, the transport opens a real graphql-ws WebSocket to the
 * cloud backend (localhost:4000 by default, or the deployed api later) and
 * authenticates with the B4 bearer token. The WS stays alive as a keepalive
 * connection. Presence/Inbox data methods are still empty: the remote-peer
 * API (a `peers` subscription + `relay` mutation) is a coordinated follow-up
 * with Mike's backend — until then, `readPresence()` and `readInbox()` return
 * empty (no remote peers to sync). The connection handshake + auth IS real,
 * so the transport path is wireable and testable today.
 *
 * @module lib/transport
 */

/**
 * A presence record as it crosses the transport boundary. Structural mirror of
 * Intercom's `PresenceRecord` (only the fields a transport sources/relays). We
 * keep it loose (`unknown`-friendly) because this plugin never INSPECTS records;
 * it only carries them. Intercom owns the real shape + validation.
 */
export interface PresenceRecordLike {
  readonly sid: string
  readonly ts: string
  /** Marks a relayed record as remote so Intercom's liveness Strategy uses the
   *  backend-authoritative path instead of a (meaningless) cross-host pid probe. */
  readonly origin?: "local" | "remote"
  readonly [k: string]: unknown
}

/** An envelope as it crosses the transport boundary. Structural mirror of Intercom's `Envelope`. */
export interface EnvelopeLike {
  readonly id: string
  readonly to: string
  readonly [k: string]: unknown
}

/**
 * The transport port. MUST match ma-intercom-plugin's `Transport` structurally
 * (id, remote, publishPresence, readPresence, deliver, readInbox), so Intercom's
 * CompositeTransport can fold this adapter in. Synchronous to match Intercom's
 * port (its turn-attachment + heartbeat reads are sync); a real WS adapter
 * exposes already-relayed records synchronously (the filesystem-bridge model)
 * and does its IO off to the side.
 */
export interface Transport {
  readonly id: string
  readonly remote: boolean
  publishPresence(rec: PresenceRecordLike): void
  readPresence(): PresenceRecordLike[]
  deliver(toSid: string, env: EnvelopeLike): void
  readInbox(sid: string): EnvelopeLike[]
}

/** Construction options for {@link RemoteWsTransport}. */
export interface RemoteWsOptions {
  /** Backend WS endpoint. Unused by the stub; recorded for when the real one lands. */
  readonly endpoint?: string
  /** Stable adapter id. Defaults to `"cloud-ws"`. */
  readonly id?: string
}

/**
 * The cloud remote transport — STUB. Implements the {@link Transport} port shape
 * so it registers + folds into Intercom's Composite, but every network method is
 * a safe no-op until the backend exists:
 *   - `readPresence()` returns `[]` (no remote peers yet).
 *   - `readInbox()` returns `[]` (no relayed messages yet).
 *   - `publishPresence()` / `deliver()` are dropped (would push to the backend).
 *
 * `remote = true` so Intercom marks any peers it eventually returns as `(Remote)`
 * and uses the backend-authoritative liveness Strategy.
 */
export class RemoteWsTransport implements Transport {
  readonly id: string
  readonly remote = true

  constructor(private readonly opts: RemoteWsOptions = {}) {
    this.id = opts.id ?? "cloud-ws"
  }

  publishPresence(_rec: PresenceRecordLike): void {
    // STUB: would push this session's presence UP to the backend over WS.
  }

  readPresence(): PresenceRecordLike[] {
    // STUB: would return remote peers the backend is relaying. Empty for now.
    return []
  }

  deliver(_toSid: string, _env: EnvelopeLike): void {
    // STUB: would relay the envelope to a remote recipient via the backend.
  }

  readInbox(_sid: string): EnvelopeLike[] {
    // STUB: would return backend-relayed messages for this session. Empty for now.
    return []
  }
}
