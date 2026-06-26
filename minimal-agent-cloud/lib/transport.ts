/**
 * The Transport PORT shape + the real RemoteWsTransport wired to Mike's v4
 * peer-subscription API (Phase E).
 *
 * ## Architecture (filesystem bridge, research-core Option B)
 *
 * The remote transport subscribes to the backend's `peerPresenceAdded` +
 * `remoteMessageReceived(sid)` streams over a single graphql-ws WebSocket, and
 * WRITES each relayed record/envelope into the SAME local filesystem directories
 * Intercom's `LocalFsTransport` already reads (`presence/<sid>.json` +
 * `inbox/<sid>.jsonl`). Intercom then reads them transparently through the
 * `CompositeTransport` as ordinary records (stamped `origin: "remote"` + the
 * remote `computerId`) — zero Intercom code change.
 *
 * Uplink (`publishPresence` / `deliver`) uses two GraphQL mutations over plain
 * fetch: `publishPeerPresence` to push this session's presence to the backend,
 * and `sendRemoteMessage` to relay a message to a remote peer.
 *
 * The connection is opened on first use (lazy) and held as a keepalive. The
 * entire transport is synchronous at the call site (matching Intercom's port) —
 * network operations fire off to the side, and already-relayed records are read
 * synchronously from the local fs.
 *
 * ## Decoupling note
 *
 * Same rule as always: this plugin NEVER imports `ma-intercom-plugin`. It
 * re-declares the structural shapes. TypeScript's structural typing makes our
 * objects satisfy Intercom's port at runtime, and the host registry only
 * requires `{ id }`, so the host accepts it.
 *
 * @module lib/transport
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { loadAuth } from "./token-store.ts"

// ---------------------------------------------------------------------------
// Local filesystem paths (matches intercom's lib/paths.ts exactly)
// ---------------------------------------------------------------------------

function homeDir(env?: NodeJS.ProcessEnv): string {
  return env?.MINIMAL_AGENT_HOME?.trim() || join(homedir(), ".minimal-agent")
}

function presenceDir(env?: NodeJS.ProcessEnv): string {
  return join(homeDir(env), "intercom", "presence")
}

function inboxDir(env?: NodeJS.ProcessEnv): string {
  return join(homeDir(env), "intercom", "inbox")
}

function presencePath(sid: string, env?: NodeJS.ProcessEnv): string {
  return join(presenceDir(env), `${sid}.json`)
}

function inboxPath(sid: string, env?: NodeJS.ProcessEnv): string {
  return join(inboxDir(env), `${sid}.jsonl`)
}

// ---------------------------------------------------------------------------
// Structural port shapes (re-declared locally — no intercom import)
// ---------------------------------------------------------------------------

export interface PresenceRecordLike {
  readonly sid: string
  readonly ts: string
  readonly origin?: "local" | "remote"
  readonly [k: string]: unknown
}

export interface EnvelopeLike {
  readonly id: string
  readonly to: string
  readonly [k: string]: unknown
}

export interface Transport {
  readonly id: string
  readonly remote: boolean
  publishPresence(rec: PresenceRecordLike): void
  readPresence(): PresenceRecordLike[]
  deliver(toSid: string, env: EnvelopeLike): void
  readInbox(sid: string): EnvelopeLike[]
}

// ---------------------------------------------------------------------------
// RemoteWsTransport — the real adapter, wired to Phase E (contract v4)
// ---------------------------------------------------------------------------

/** Construction options. */
export interface RemoteWsOptions {
  readonly id?: string
  /** Our own session id, so the `remoteMessageReceived` subscription targets us. */
  readonly selfSid?: string
  /** GraphQL WS endpoint. Defaults to `ws://localhost:4000/graphql`. */
  readonly wsUrl?: string
  /** GraphQL HTTP endpoint. Defaults to `http://localhost:4000/graphql`. */
  readonly httpUrl?: string
  /** Env for agent-home resolution. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv
}

/** Coarse safe-id guard (matches intercom's isSafeSid). */
const SAFE_SID = /^[A-Za-z0-9_-]{1,128}$/
function isSafeSid(s: string): boolean {
  return SAFE_SID.test(s)
}

/** Write a presence record atomically (temp + rename — matches intercom). */
function atomicWritePresence(path: string, rec: Record<string, unknown>): void {
  try {
    mkdirSync(presenceDir(), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, `${JSON.stringify(rec)}\n`)
    renameSync(tmp, path)
  } catch {
    // best-effort: a failed presence write must never break the REPL
  }
}

/** Append an envelope to a JSONL inbox (O_APPEND — matches intercom). */
function appendEnvelope(path: string, env: EnvelopeLike): void {
  try {
    mkdirSync(inboxDir(), { recursive: true })
    appendFileSync(path, `${JSON.stringify(env)}\n`)
  } catch {
    // best-effort
  }
}

/** Read all presence records the remote transport relayed (synchronous fs read). */
function readLocalPresenceDir(env?: NodeJS.ProcessEnv): PresenceRecordLike[] {
  const dir = presenceDir(env)
  if (!existsSync(dir)) return []
  const out: PresenceRecordLike[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  for (const name of names) {
    if (!name.endsWith(".json") || name.includes(".tmp-")) continue
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf-8")) as Record<string, unknown>
      if (isSafeSid(raw.sid as string)) out.push(raw as PresenceRecordLike)
    } catch {
      // skip corrupt
    }
  }
  return out
}

/** Read a local inbox (synchronous fs read). */
function readLocalInbox(sid: string, env?: NodeJS.ProcessEnv): EnvelopeLike[] {
  const path = inboxPath(sid, env)
  if (!existsSync(path)) return []
  try {
    const text = readFileSync(path, "utf-8")
    const out: EnvelopeLike[] = []
    for (const line of text.split("\n")) {
      const t = line.trim()
      if (!t) continue
      try {
        const e = JSON.parse(t) as Record<string, unknown>
        if (typeof e.id === "string") out.push(e as EnvelopeLike)
      } catch {
        // skip corrupt line
      }
    }
    return out
  } catch {
    return []
  }
}

// Putative graphql-ws client symbols
interface GqlWsSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: "open" | "message" | "error" | "close", cb: (ev: unknown) => void): void
  removeEventListener?: (type: string, cb: (ev: unknown) => void) => void
}
type WsFactory = (url: string, proto?: string | string[]) => GqlWsSocket

let defaultWs: WsFactory | undefined
function getDefaultWs(): WsFactory {
  if (defaultWs) return defaultWs
  const Ctor = (globalThis as { WebSocket?: unknown }).WebSocket as
    | (new (url: string, proto?: string | string[]) => GqlWsSocket)
    | undefined
  if (!Ctor) throw new Error("no global WebSocket")
  defaultWs = (url, proto) => new Ctor(url, proto)
  return defaultWs
}

const SUBPROTOCOL = "graphql-transport-ws"

function wsSend(ws: GqlWsSocket, obj: unknown): void {
  try {
    ws.send(JSON.stringify(obj))
  } catch {
    // best-effort
  }
}

/** Open a lazy keepalive graphql-ws connection to the backend, authenticated with the B4 bearer. */
function connectWs(
  opts: RemoteWsOptions,
  bearer: string,
  wsFactory: WsFactory,
): GqlWsSocket | null {
  const url = opts.wsUrl ?? "ws://localhost:4000/graphql"
  try {
    const ws = wsFactory(url, SUBPROTOCOL)
    ws.addEventListener("open", () => {
      wsSend(ws, { type: "connection_init", payload: { authorization: `Bearer ${bearer}` } })
    })
    ws.addEventListener("error", () => {
      // Connection failure: the transport stays in stub mode (empty roster).
      // Intercom's CompositeTransport tolerates a child that returns [].
    })
    return ws
  } catch {
    return null
  }
}

/** Subscribe to a single graphql-ws channel over an already-connected socket. */
function subscribe(
  ws: GqlWsSocket,
  id: string,
  query: string,
  variables: Record<string, unknown>,
  onNext: (data: unknown) => void,
): void {
  wsSend(ws, { type: "subscribe", id, payload: { query, variables } })
  const listener = (ev: unknown) => {
    const raw = (ev as { data?: unknown }).data
    let msg: { type?: string; id?: string; payload?: unknown }
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : String(raw))
    } catch {
      return
    }
    if (msg.type === "next" && msg.id === id) {
      const data = (msg.payload as { data?: unknown } | undefined)?.data
      if (data !== undefined) onNext(data)
    }
  }
  ws.addEventListener("message", listener)
}

/** POST a GraphQL mutation over fetch with the bearer. */
async function gqlMutate<T>(
  httpUrl: string,
  bearer: string,
  query: string,
  variables: Record<string, unknown>,
  pick: (d: Record<string, unknown>) => T | undefined,
): Promise<T | undefined> {
  try {
    const res = await fetch(httpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as {
      data?: Record<string, unknown>
      errors?: { message?: string }[]
    }
    if (body.errors?.length) return undefined
    return body.data ? pick(body.data) : undefined
  } catch {
    return undefined
  }
}

/** Mutations / subscriptions for contract v4. */
const PUBLISH_MUTATION =
  "mutation($r:JSON!){publishPeerPresence(record:$r){sid accepted}}"
const SEND_MUTATION =
  "mutation($e:JSON!){sendRemoteMessage(envelope:$e){sent messageId}}"
const PRESENCE_SUB =
  "subscription{peerPresenceAdded{sid machineId hostname model cwd phase activity v short pid lastBeat}}"
const INBOX_SUB =
  "subscription($sid:ID!){remoteMessageReceived(sid:$sid){id v ts kind fromSid fromShort fromPid fromHost fromCwd fromModel toSid scope body replyTo}}"

/**
 * The real cloud remote transport — wired to the peer-subscription API.
 *
 * Connects to the backend over graphql-ws on first use, subscribes to
 * `peerPresenceAdded` and `remoteMessageReceived`, writes relayed records into
 * the local filesystem, and reads them synchronously so Intercom sees them as
 * ordinary local peers with `origin: "remote"`.
 */
export class RemoteWsTransport implements Transport {
  readonly id: string
  readonly remote = true
  private readonly opts: Required<RemoteWsOptions> & { wsFactory: WsFactory }
  private ws: GqlWsSocket | null = null
  private cachedSelfSid: string | null = null

  constructor(opts: RemoteWsOptions = {}) {
    this.id = opts.id ?? "cloud-ws"
    this.cachedSelfSid = opts.selfSid ?? null
    this.opts = {
      id: opts.id ?? "cloud-ws",
      selfSid: opts.selfSid ?? "",
      wsUrl: opts.wsUrl ?? "ws://localhost:4000/graphql",
      httpUrl: opts.httpUrl ?? "http://localhost:4000/graphql",
      env: opts.env ?? process.env,
      wsFactory: getDefaultWs(),
    }
  }

  /** Ensure the WS is connected + subscriptions open (lazy). */
  private ensureConnected(): void {
    if (this.ws) return
    const auth = loadAuth(this.opts.env)
    if (!auth) return
    const ws = connectWs(this.opts, auth.accessToken, this.opts.wsFactory)
    if (!ws) return
    this.ws = ws

    // Downlink 1: peerPresenceAdded → write to local presence dir
    const ourSid = this.cachedSelfSid || this.opts.selfSid || null
    subscribe(ws, "presence", PRESENCE_SUB, {}, (data) => {
      const p = data as Record<string, unknown>
      if (!isSafeSid(p.sid as string)) return
      const rec: Record<string, unknown> = {
        v: typeof p.v === "number" ? p.v : 1,
        sid: p.sid,
        short: typeof p.short === "string" ? p.short : String(p.sid ?? "").slice(0, 8),
        pid: typeof p.pid === "number" ? p.pid : 0,
        host: typeof p.hostname === "string" ? p.hostname : "",
        ts: typeof p.lastBeat === "string" ? p.lastBeat : new Date().toISOString(),
        startedAt: typeof p.lastBeat === "string" ? p.lastBeat : new Date().toISOString(),
        agentVersion: "",
        model: typeof p.model === "string" ? p.model : "",
        cwd: typeof p.cwd === "string" ? p.cwd : "",
        projectRoot: typeof p.cwd === "string" ? p.cwd : "",
        phase: typeof p.phase === "string" ? p.phase : "active",
        activity: typeof p.activity === "string" ? p.activity : null,
        origin: "remote", // triggers the backend-authoritative liveness Strategy
        ...(typeof p.machineId === "string" ? { computerId: p.machineId } : {}),
      }
      atomicWritePresence(presencePath(rec.sid as string, this.opts.env), rec)
    })

    // Downlink 2: remoteMessageReceived → append to local inbox
    if (ourSid) {
      subscribe(ws, "inbox", INBOX_SUB, { sid: ourSid }, (data) => {
        const env = data as Record<string, unknown>
        if (typeof env.id !== "string") return
        const to = typeof env.toSid === "string" ? env.toSid : ourSid
        appendEnvelope(inboxPath(to, this.opts.env), {
          id: env.id,
          to,
          ...env,
        } as unknown as EnvelopeLike)
      })
    }
  }

  // -- Transport port (synchronous — the call site contract) -------------------

  publishPresence(rec: PresenceRecordLike): void {
    const auth = loadAuth(this.opts.env)
    if (!auth) return
    void gqlMutate(this.opts.httpUrl, auth.accessToken, PUBLISH_MUTATION, { r: rec }, (d) => d)
  }

  readPresence(): PresenceRecordLike[] {
    this.ensureConnected()
    return readLocalPresenceDir(this.opts.env)
  }

  deliver(toSid: string, _env: EnvelopeLike): void {
    if (!isSafeSid(toSid)) return
    const auth = loadAuth(this.opts.env)
    if (!auth) return
    void gqlMutate(this.opts.httpUrl, auth.accessToken, SEND_MUTATION, { e: _env }, (d) => d)
  }

  readInbox(sid: string): EnvelopeLike[] {
    if (!isSafeSid(sid)) return []
    this.ensureConnected()
    return readLocalInbox(sid, this.opts.env)
  }

  // -- Helpers ----------------------------------------------------------------
}
