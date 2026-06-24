/**
 * The Transport PORT — the seam that makes Intercom transport-agnostic.
 *
 * ## Why this exists (Ports & Adapters)
 *
 * Today every message send/receive and every presence publish/read is welded to
 * `node:fs` (see `lib/inbox.ts`, `lib/presence.ts`). That makes "is this peer
 * local or remote?" un-answerable: there is no boundary to vary. This module
 * introduces ONE port — {@link Transport} — that is the only thing the service
 * layer and the receive handlers talk to. The pure record/parse/classify core
 * (`envelope.ts`, `liveness.ts`, `roster.ts`, `cursors.ts`) is untouched; it
 * already operates on plain records.
 *
 * Two adapters implement the port:
 *   - {@link LocalFsTransport} — wraps today's fs calls VERBATIM (this file is
 *     the only place that changes; behavior is byte-identical). Ships here, in
 *     Intercom, and is always present.
 *   - `RemoteWsTransport` — lives in the future `minimal-agent-cloud` plugin and
 *     speaks WebSocket to the cloud backend. Intercom NEVER imports it; the
 *     cloud plugin registers it through the host-brokered registry (see
 *     {@link TransportRegistryApi} in `host-types.ts`) and Intercom folds it into
 *     a {@link CompositeTransport} alongside the always-present local adapter.
 *
 * ## Why the port is SYNCHRONOUS (deliberate, not an oversight)
 *
 * The host contract forces it: a turn-attachment's `toAttachment()` is a
 * SYNCHRONOUS method (`TurnAttachmentProducer.toAttachment(): … | null`), and
 * the heartbeat's `runBeat()` is a synchronous pure function. The inbox read
 * that feeds the per-turn `<ma::agent::intercom-inbox>` block therefore CANNOT
 * become async without changing the host-facing handler shape — which would
 * violate the A5 "pure internal seam extraction, behavior identical" guardrail.
 *
 * So this port mirrors today's synchronous fs IO exactly. Remote peers integrate
 * WITHOUT making this port async, via the filesystem-bridge model (research-core
 * Option B): the cloud plugin relays remote presence/messages by writing them
 * into the SAME local dirs, so {@link LocalFsTransport} reads them synchronously
 * as ordinary records (stamped `origin: "remote"`). If a future design ever
 * needs a truly in-process async remote transport in the Composite, that is a
 * deliberate, versioned addition of an async read path ALONGSIDE this one — not
 * a breaking change made now.
 *
 * ## What is and isn't on the port (Interface Segregation)
 *
 * The port carries exactly what crosses the SESSION boundary: presence
 * (publish/read) and messages (deliver/read-inbox). Cursors (`seen`/`woken`/
 * `read` high-water marks) are deliberately NOT on the port: they are
 * recipient-owned LOCAL bookkeeping, meaningless to a remote peer, so they stay
 * as direct local calls (`lib/cursors.ts`). "Roster" is likewise not a transport
 * method — a roster is DERIVED (`buildRoster(transport.readPresence())`), pure
 * and origin-agnostic, so adding a `roster()` to the transport would duplicate
 * that logic. The transport's job is to source records; building the view is the
 * roster module's job.
 *
 * @module lib/transport
 */

import type { Envelope } from "./envelope.ts"
import type { PresenceRecord } from "./presence.ts"
import { mergePresence } from "./roster.ts"

/**
 * The transport port. The single abstraction the service layer + receive
 * handlers depend on, so local-vs-remote becomes an injected detail.
 *
 * All methods are synchronous (see the module doc for why). A remote adapter
 * that needs IO concurrency does it behind its own machinery and exposes a
 * synchronous read of already-relayed records (the filesystem-bridge model).
 */
export interface Transport {
  /** Stable adapter id, e.g. `"local-fs"`, `"cloud-ws"`. For diagnostics. */
  readonly id: string
  /**
   * Does this transport reach peers on OTHER machines? Drives the `(Remote)`
   * marker and the liveness Strategy. `false` for the local fs adapter.
   */
  readonly remote: boolean

  // -- presence -------------------------------------------------------------
  /** Publish THIS session's presence record (atomic, last-write-wins). */
  publishPresence(rec: PresenceRecord): void
  /** Read every presence record this transport can see (its own peers). */
  readPresence(): PresenceRecord[]

  // -- messaging ------------------------------------------------------------
  /** Deliver one envelope to a recipient sid (append to its queue). */
  deliver(toSid: string, env: Envelope): void
  /** Read a recipient's whole inbox (the inbox owner is always local = me). */
  readInbox(sid: string): Envelope[]
}

// ---------------------------------------------------------------------------
// LocalFsTransport — the default adapter (wraps today's fs IO verbatim)
// ---------------------------------------------------------------------------

/**
 * The function surface {@link LocalFsTransport} delegates to. Injected so the
 * adapter is unit-testable without disk, and so the adapter NEVER hardcodes a
 * path or an fs call inline — it just forwards to the existing pure-ish shells
 * (`lib/inbox.ts`, `lib/presence.ts`, `lib/paths.ts`). The handlers build this
 * from the real modules; tests pass fakes.
 */
export interface LocalFsIo {
  presencePath(sid: string): string
  presenceDir(): string
  inboxPath(sid: string): string
  writePresence(path: string, rec: PresenceRecord): void
  readPresenceDir(dir: string): PresenceRecord[]
  appendEnvelope(path: string, env: Envelope): void
  readInbox(path: string): Envelope[]
}

/**
 * The local filesystem transport: today's behavior, behind the port. Every
 * method forwards to the injected {@link LocalFsIo} with ZERO format change —
 * same paths, same JSON, byte-identical to pre-refactor Intercom, so a
 * refactored session and an un-refactored peer stay interoperable on the same
 * files.
 */
export class LocalFsTransport implements Transport {
  readonly id = "local-fs"
  readonly remote = false

  constructor(
    private readonly io: LocalFsIo,
    private readonly selfSid: string,
  ) {}

  publishPresence(rec: PresenceRecord): void {
    this.io.writePresence(this.io.presencePath(rec.sid), rec)
  }

  readPresence(): PresenceRecord[] {
    // Records on local disk are local by definition; classifyLiveness treats a
    // missing `origin` as local, so we don't need to stamp anything here.
    return this.io.readPresenceDir(this.io.presenceDir())
  }

  deliver(toSid: string, env: Envelope): void {
    this.io.appendEnvelope(this.io.inboxPath(toSid), env)
  }

  readInbox(sid: string): Envelope[] {
    return this.io.readInbox(this.io.inboxPath(sid))
  }
}

// ---------------------------------------------------------------------------
// CompositeTransport — merge local + remote transparently (Composite pattern)
// ---------------------------------------------------------------------------

/**
 * Fans operations across several child transports so the service layer holds
 * ONE {@link Transport} and never branches on local-vs-remote.
 *
 * - `readPresence()` concatenates every child's records and dedups by newest
 *   beat via the existing pure {@link mergePresence} (so a peer seen on two
 *   transports collapses to its freshest record).
 * - `publishPresence()` / `deliver()` fan to every child (each child decides
 *   whether the target is its concern; the local fs child always writes locally,
 *   a remote child relays to the backend).
 * - `readInbox()` merges inbox lines across children (today only local has one).
 *
 * Today this is constructed with just `[localFs]`. When the cloud plugin
 * registers a `RemoteWsTransport`, it joins the children list and remote peers
 * appear with zero change to the service layer or the renderers — `remote`
 * flips true as soon as any child is remote.
 */
export class CompositeTransport implements Transport {
  readonly id = "composite"

  constructor(private readonly children: readonly Transport[]) {}

  get remote(): boolean {
    return this.children.some((c) => c.remote)
  }

  publishPresence(rec: PresenceRecord): void {
    for (const c of this.children) {
      try {
        c.publishPresence(rec)
      } catch {
        // one transport failing (e.g. a dropped cloud socket) must never stop
        // the others — local presence keeps working when the backend is down.
      }
    }
  }

  readPresence(): PresenceRecord[] {
    const sources: PresenceRecord[][] = []
    for (const c of this.children) {
      try {
        sources.push(c.readPresence())
      } catch {
        // skip a failed source; a dead cloud transport never blanks the roster.
      }
    }
    return mergePresence(...sources)
  }

  deliver(toSid: string, env: Envelope): void {
    for (const c of this.children) {
      try {
        c.deliver(toSid, env)
      } catch {
        // best-effort per child; the send outcome is judged by the caller via
        // roster membership, not by a transport throwing.
      }
    }
  }

  readInbox(sid: string): Envelope[] {
    const out: Envelope[] = []
    for (const c of this.children) {
      try {
        out.push(...c.readInbox(sid))
      } catch {
        // skip a failed child
      }
    }
    return out
  }
}

/**
 * Build the session's effective transport: the always-present local fs adapter
 * plus every remote transport the host registry advertises. When the registry
 * is absent (today — the host capability isn't wired yet) or empty, this returns
 * a Composite over just the local adapter, so behavior is identical to today.
 *
 * `remotes` is whatever `ctx.host.transportRegistry?.list()` returned, already
 * narrowed by the caller. Kept as a plain array param so this stays pure and
 * unit-testable (no host object needed).
 */
export function buildTransport(local: Transport, remotes: readonly Transport[] = []): Transport {
  if (remotes.length === 0) return local
  return new CompositeTransport([local, ...remotes])
}
