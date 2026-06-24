/**
 * The service layer: stateful orchestration over the pure core, parameterized
 * by its IO (env, clock, pid probe) so handlers stay thin and tests stay pure.
 *
 * This is the one place that resolves "who am I", reads the live roster off
 * disk, addresses peers, and fans messages out. Handlers translate a tool
 * input into a service call and render the result.
 *
 * @module lib/service
 */

import { resolveThresholds, type Thresholds } from "./config.ts"
import { buildEnvelope, type Envelope, type EnvelopeFrom, type MessageKind } from "./envelope.ts"
import type { AgentContext, SessionsReadApi } from "./host-types.ts"
import {
  normalizePeerRef,
  type SelfIdentity,
  selfIdentity,
  sidMatchesRef,
  thisHost,
} from "./identity.ts"
import { appendEnvelope, readInbox } from "./inbox.ts"
import { classifyLiveness, isReachable, type Liveness } from "./liveness.ts"
import { inboxPath, presenceDir, presencePath, sessionsDir } from "./paths.ts"
import { type PresenceRecord, readPresenceDir, writePresence } from "./presence.ts"
import type { InspectBundle } from "./render.ts"
import { buildRoster, type RosterRow } from "./roster.ts"
import { isSafeTeamId, normalizeTeamRef } from "./teams.ts"
import { buildTransport, LocalFsTransport, type Transport } from "./transport.ts"
import {
  type PeerFleetMember,
  type PeerJob,
  type PeerTask,
  readPeerFleet,
  readPeerJobs,
  readPeerTasks,
  summarizeTasks,
  type TaskSummary,
} from "./sidecars.ts"

/** Which deep-dive sections `inspectPeer` may gather. */
export type InspectSection = "tasks" | "jobs" | "fleet" | "activity" | "transcript"

/** Structural slice of the host `sessions:read` API we use for inspect. */
export type SessionsReadLike = Pick<SessionsReadApi, "window">

/** Every section, for the "include everything" path. */
export const ALL_INSPECT_SECTIONS: readonly InspectSection[] = [
  "tasks",
  "jobs",
  "fleet",
  "activity",
  "transcript",
]

/** A real pid liveness probe via `process.kill(pid, 0)`. */
export function realPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but we can't signal it ⇒ still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Injected dependencies for the service. */
export interface ServiceDeps {
  readonly env: NodeJS.ProcessEnv
  readonly self: SelfIdentity
  readonly thresholds: Thresholds
  readonly now: () => number
  readonly host: string
  readonly pidAlive: (pid: number) => boolean
  /**
   * The transport the service sends/reads through (Ports & Adapters). OPTIONAL:
   * when absent, the service lazily builds a default {@link LocalFsTransport}
   * over the same dirs (see {@link transportOf}), so a caller that doesn't
   * inject one — e.g. existing tests — gets byte-identical local behavior. The
   * production handlers inject the effective transport (local + any remote the
   * host registry advertised) so remote peers integrate without the service
   * branching on origin.
   */
  readonly transport?: Transport
}

/**
 * Build the default local filesystem transport for a session — wires the real
 * `paths`/`presence`/`inbox` shells behind the {@link Transport} port. This is
 * the ONE place the local adapter binds to concrete fs functions, all of them
 * the exact calls Intercom used pre-A5 (no path or format change).
 */
export function makeLocalFsTransport(
  env: NodeJS.ProcessEnv,
  selfSid: string,
): LocalFsTransport {
  return new LocalFsTransport(
    {
      presencePath: (sid) => presencePath(sid, env),
      presenceDir: () => presenceDir(env),
      inboxPath: (sid) => inboxPath(sid, env),
      writePresence,
      readPresenceDir,
      appendEnvelope,
      readInbox,
    },
    selfSid,
  )
}

/** The service's effective transport: the injected one, or a lazy local default. */
function transportOf(deps: ServiceDeps): Transport {
  return deps.transport ?? makeLocalFsTransport(deps.env, deps.self.sid)
}

/**
 * A minimal structural slice of `ctx.host` the service reads to discover remote
 * transports. Kept local (not importing host-types' full `PluginHost`) so this
 * stays a tiny, stable contract. Absent / unwired ⇒ local-only.
 */
export interface TransportHostSlice {
  readonly transportRegistry?: { list(): Transport[] }
}

/**
 * Build {@link ServiceDeps} from a handler context, or null when no session id.
 *
 * `host` is the optional `ctx.host`: when it carries a `transportRegistry`
 * (the `intercom:transport` capability — not wired in core yet), every remote
 * transport it advertises is folded into the effective transport alongside the
 * always-present local fs adapter (Composite). Today the registry is always
 * absent, so this returns a plain local transport and behavior is identical to
 * pre-A5.
 */
export function serviceDepsFromAgent(
  agent: AgentContext | undefined,
  env: NodeJS.ProcessEnv = process.env,
  host?: TransportHostSlice,
): ServiceDeps | null {
  const self = selfIdentity(agent)
  if (!self) return null
  const local = makeLocalFsTransport(env, self.sid)
  const remotes = safeListRemotes(host)
  const transport: Transport = buildTransport(local, remotes)
  return {
    env,
    self,
    thresholds: resolveThresholds(env),
    now: () => Date.now(),
    host: thisHost(),
    pidAlive: realPidAlive,
    transport,
  }
}

/** Read the host's remote transports defensively (registry may be absent/throw). */
function safeListRemotes(host: TransportHostSlice | undefined): Transport[] {
  try {
    return host?.transportRegistry?.list() ?? []
  } catch {
    return []
  }
}

/**
 * Build the peer roster from intercom's OWN presence feed.
 *
 * The roster is intentionally limited to sessions running intercom, because the
 * heartbeat that writes a presence record is a live-area slot that only runs in
 * an interactive REPL. That population is exactly "sessions you can actually
 * message" (a peer must run intercom to receive the inbox attachment + wake).
 *
 * We deliberately do NOT merge the sub-agents presence feed
 * (`~/.minimal-agent/presence/`) here. That feed lists a lead plus every worker
 * it ever spawned, including terminal/`done` workers — dragging it into the
 * roster filled it with un-messageable corpses (the "N peers" graveyard).
 * Sub-agent workers are headless, talk to their lead via `Mailbox`, and are not
 * intercom peers. The sub-agents feed is still GC'd for hygiene (see lib/gc.ts)
 * and read for `Peers inspect <lead>` to show a peer's fleet (see lib/sidecars.ts).
 */
export function loadRoster(
  deps: ServiceDeps,
  opts: { excludeSelf?: boolean; liveOnly?: boolean } = {},
): RosterRow[] {
  // Source presence through the transport port. The local fs transport returns
  // exactly `readPresenceDir(presenceDir(env))` (today's behavior); a composite
  // also folds in remote peers, merged by newest beat — same `buildRoster` call.
  const own = transportOf(deps).readPresence()
  return buildRoster(own, {
    thresholds: deps.thresholds,
    probe: { now: deps.now(), pidAlive: deps.pidAlive, host: deps.host },
    selfSid: deps.self.sid,
    ...(opts.excludeSelf ? { excludeSelf: true } : {}),
    ...(opts.liveOnly ? { liveOnly: true } : {}),
  })
}

/** Find a single peer by reference (short id, full sid, or at-mention). */
export type ResolvePeer =
  | { readonly ok: true; readonly row: RosterRow }
  | {
      readonly ok: false
      readonly reason: "not-found" | "ambiguous" | "self"
      readonly candidates: string[]
    }

/** Resolve a peer reference against the live roster. */
export function resolvePeer(deps: ServiceDeps, ref: string): ResolvePeer {
  const norm = normalizePeerRef(ref)
  if (norm.length === 0) return { ok: false, reason: "not-found", candidates: [] }
  const roster = loadRoster(deps, { excludeSelf: false })
  const matches = roster.filter((row) => sidMatchesRef(row.record.sid, norm))
  if (matches.length === 0) return { ok: false, reason: "not-found", candidates: [] }
  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous", candidates: matches.map((m) => m.record.short) }
  }
  const row = matches[0] as RosterRow
  if (row.record.sid === deps.self.sid) {
    return { ok: false, reason: "self", candidates: [] }
  }
  return { ok: true, row }
}

/** My self-contained `from` block for outgoing envelopes. */
export function selfFrom(deps: ServiceDeps): EnvelopeFrom {
  return {
    sid: deps.self.sid,
    short: deps.self.short,
    pid: deps.self.pid,
    host: deps.self.host,
    cwd: deps.env.PWD ?? "",
    model: deps.self.model,
  }
}

/** The outcome of a send. */
export interface SendOutcome {
  readonly delivered: { short: string; sid: string }[]
  readonly skipped: { ref: string; reason: string }[]
  readonly scope: string
  readonly kind: MessageKind
  readonly envelopeId: string | null
}

/** Inputs to {@link send}. */
export interface SendInput {
  readonly to: string
  readonly body: string
  readonly kind: MessageKind
  readonly replyTo?: string
  /** Override the cwd captured in the `from` block (handlers pass ctx.cwd). */
  readonly fromCwd?: string
}

/**
 * Send a message. Resolves the address (a peer ref, "all", or "project"),
 * builds one envelope per recipient, and appends to each recipient's inbox.
 * Self is never a recipient. Pure-ish: all IO is the inbox append + roster
 * read, both via injected paths.
 */
export function send(deps: ServiceDeps, input: SendInput): SendOutcome {
  const from: EnvelopeFrom = { ...selfFrom(deps), ...(input.fromCwd ? { cwd: input.fromCwd } : {}) }
  const toRaw = input.to.trim()
  const scope = toRaw
  const delivered: { short: string; sid: string }[] = []
  const skipped: { ref: string; reason: string }[] = []

  // Resolve recipients.
  let recipients: RosterRow[] = []
  const lower = toRaw.toLowerCase()
  if (lower === "all" || lower === "*" || lower === "broadcast") {
    recipients = liveRecipients(deps)
  } else if (lower === "project" || lower === "project:.") {
    const root = deps.env.PWD ?? input.fromCwd ?? ""
    recipients = liveRecipients(deps).filter(
      (r) => r.record.projectRoot === root || r.record.cwd === root,
    )
  } else if (lower.startsWith("team:")) {
    // 4th scope: team:<id> — every reachable peer whose presence record lists
    // this team id. The LOCAL half (presence teams[]) resolves today; remote
    // members fold in automatically because liveRecipients reads through the
    // transport port (a composite already merges remote presence in). No
    // team-specific transport call is needed here for the local primitive.
    const teamId = normalizeTeamRef(toRaw)
    if (!isSafeTeamId(teamId)) {
      skipped.push({ ref: toRaw, reason: "invalid team id" })
      return { delivered, skipped, scope, kind: input.kind, envelopeId: null }
    }
    recipients = liveRecipients(deps).filter(
      (r) => Array.isArray(r.record.teams) && r.record.teams.includes(teamId),
    )
  } else {
    const res = resolvePeer(deps, toRaw)
    if (!res.ok) {
      skipped.push({
        ref: toRaw,
        reason:
          res.reason === "self"
            ? "cannot send to self"
            : res.reason === "ambiguous"
              ? `ambiguous (matches: ${res.candidates.join(", ")})`
              : "no such peer",
      })
      return { delivered, skipped, scope, kind: input.kind, envelopeId: null }
    }
    recipients = [res.row]
  }

  if (recipients.length === 0) {
    return { delivered, skipped, scope, kind: input.kind, envelopeId: null }
  }

  // One envelope id per send (shared across fan-out so a broadcast is one
  // logical message the model can dedup), but delivered per-recipient.
  const transport = transportOf(deps)
  const nowMs = deps.now()
  let envelopeId: string | null = null
  for (const row of recipients) {
    if (row.record.sid === deps.self.sid) continue
    const env: Envelope = buildEnvelope({
      from,
      to: row.record.sid,
      scope,
      kind: input.kind,
      body: input.body,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      nowMs,
    })
    envelopeId = env.id
    try {
      // Deliver through the transport port: the local fs adapter appends to
      // `inbox/<sid>.jsonl` exactly as before; a composite routes a remote sid
      // to the cloud transport instead. The service never branches on origin.
      transport.deliver(row.record.sid, env)
      delivered.push({ short: row.record.short, sid: row.record.sid })
    } catch {
      skipped.push({ ref: row.record.short, reason: "inbox write failed" })
    }
  }
  return { delivered, skipped, scope, kind: input.kind, envelopeId }
}

/** Live (reachable) peers, excluding self. */
function liveRecipients(deps: ServiceDeps): RosterRow[] {
  return loadRoster(deps, { excludeSelf: true }).filter((r) => isReachable(r.liveness))
}

/** Classify a single record (used by inspect). */
export function classify(deps: ServiceDeps, rec: PresenceRecord): Liveness {
  return classifyLiveness(rec, deps.thresholds, {
    now: deps.now(),
    pidAlive: deps.pidAlive,
    host: deps.host,
  })
}

/**
 * Gather a peer's cross-plugin state into an {@link InspectBundle}. This is the
 * inter-plugin aggregation core: it reads OTHER plugins' per-session sidecars
 * (tasks / bgjobs / fleet) with tolerant local parsers and, optionally, the
 * host `sessions:read` capability for activity + a transcript excerpt — without
 * importing any of those plugins.
 *
 * `host` is the optional `sessions:read` API (from `ctx.host?.sessions`).
 * Sections are gathered per `include`; failures are collected in `notes` rather
 * than thrown, so a partial answer still returns.
 */
export async function inspectPeer(
  deps: ServiceDeps,
  rec: PresenceRecord,
  include: ReadonlySet<InspectSection>,
  host?: SessionsReadLike,
): Promise<InspectBundle> {
  const dir = sessionsDir(deps.env)
  const notes: string[] = []
  const liveness = classify(deps, rec)
  const bundle: {
    record: PresenceRecord
    liveness: Liveness
    tasks?: { list: PeerTask[]; summary: TaskSummary }
    jobs?: PeerJob[]
    fleet?: PeerFleetMember[]
    activity?: string[]
    transcript?: string[]
    notes?: string[]
  } = { record: rec, liveness }

  if (include.has("tasks")) {
    try {
      const list = readPeerTasks(dir, rec.sid)
      bundle.tasks = { list, summary: summarizeTasks(list) }
    } catch {
      notes.push("could not read tasks")
    }
  }
  if (include.has("jobs")) {
    try {
      bundle.jobs = readPeerJobs(dir, rec.sid)
    } catch {
      notes.push("could not read background jobs")
    }
  }
  if (include.has("fleet")) {
    try {
      bundle.fleet = readPeerFleet(dir, rec.sid)
    } catch {
      notes.push("could not read sub-agent fleet")
    }
  }
  if ((include.has("activity") || include.has("transcript")) && host) {
    try {
      const win = await host.window(rec.sid, {
        anchor: "end",
        limit: include.has("transcript") ? 12 : 6,
        previewChars: include.has("transcript") ? 200 : 90,
      })
      if (win) {
        const rows = win.items.map(
          (r) =>
            `#${r.index} ${r.kind}${r.ts ? ` ${r.ts.slice(11, 19)}` : ""}: ${r.preview.replace(/\s+/g, " ").slice(0, include.has("transcript") ? 200 : 90)}`,
        )
        if (include.has("transcript")) bundle.transcript = rows
        else bundle.activity = rows
      }
    } catch {
      notes.push("could not read transcript (sessions:read unavailable)")
    }
  } else if ((include.has("activity") || include.has("transcript")) && !host) {
    notes.push("transcript/activity needs the sessions:read capability")
  }

  if (notes.length > 0) bundle.notes = notes
  return bundle
}
