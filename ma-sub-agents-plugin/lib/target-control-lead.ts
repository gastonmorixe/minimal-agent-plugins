/**
 * Lead side of the target control channel: when the lead switches its
 * target, each RUNNING worker gets one signed line in its control file, so
 * it can switch in place. See core `plugin-api/utils/target-control` for the
 * line format and the security rules.
 *
 * The lead's secret is in memory only (never on disk, never in a file that a
 * tool can read). A restarted lead has a new secret, so it cannot reach the
 * workers of its earlier process: {@link writeSwitchLines} counts them, and
 * the caller tells the user.
 *
 * @module sub-agents/lib/target-control-lead
 */

import { randomBytes } from "node:crypto"
import { closeSync, constants, fstatSync, mkdirSync, openSync, writeSync } from "node:fs"
import { dirname } from "node:path"

import {
  type ControlTarget,
  controlKeyId,
  controlPathFor,
  deriveControlKey,
  ENV_TARGET_CONTROL_FILE,
  ENV_TARGET_CONTROL_KEY,
  signSwitchLine,
} from "@minimal-agent/core/plugin-api/utils/target-control"

import type { SubagentRecord } from "./types.ts"

/** The lead's control state for one process: its secret and its line counter. */
interface LeadControlState {
  readonly secret: string
  seq: number
}

// One state for the process, also across a plugin module that loads twice.
const STATE_KEY = Symbol.for("minimal-agent.sub-agents.target-control")

function state(): LeadControlState {
  const holder = globalThis as unknown as Record<symbol, LeadControlState | undefined>
  let current = holder[STATE_KEY]
  if (!current) {
    current = { secret: randomBytes(32).toString("hex"), seq: 0 }
    holder[STATE_KEY] = current
  }
  return current
}

/** Forget the secret (tests: the same as a lead restart). */
export function resetLeadControlForTests(): void {
  delete (globalThis as unknown as Record<symbol, unknown>)[STATE_KEY]
}

/** What one worker gets at spawn for the control channel. */
export interface ChildControl {
  /** Env for the worker: its file path and its key. The worker removes both at boot. */
  readonly env: Record<string, string>
  /** Public id of the lead secret, for the worker record. */
  readonly keyId: string
}

/** The control env and key id for a new worker of this lead process. */
export function childControl(sessionsDir: string, childSid: string): ChildControl {
  const { secret } = state()
  return {
    env: {
      [ENV_TARGET_CONTROL_FILE]: controlPathFor(sessionsDir, childSid),
      [ENV_TARGET_CONTROL_KEY]: deriveControlKey(secret, childSid),
    },
    keyId: controlKeyId(secret),
  }
}

/** How one switch went for the fleet. */
export interface SwitchLinesResult {
  /** Running workers that got a line. */
  readonly sent: number
  /** Running workers this lead process cannot reach (spawned before it started, or by an older build). */
  readonly unreachable: number
  /** Running workers whose file could not be written. */
  readonly failed: number
}

/**
 * Append one line to `path`. The file is made with mode 0600 at create, in
 * append mode, and a symlink at the path is refused. The path must be a
 * regular file of this user.
 *
 * @throws Error when the path is not a regular file of this user, or on an I/O error
 */
export function appendControlLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW
  const fd = openSync(path, flags, 0o600)
  try {
    const stat = fstatSync(fd)
    const uid = process.getuid?.()
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) {
      throw new Error("control file is not a regular file of this user")
    }
    writeSync(fd, `${line}\n`)
  } finally {
    closeSync(fd)
  }
}

/**
 * Tell each RUNNING worker of `records` that the lead went from `from` to `to`.
 * A worker follows by its own rule (it can also ignore the line). A worker
 * that this lead process cannot reach gets no line.
 */
export function writeSwitchLines(
  records: readonly SubagentRecord[],
  change: { from: ControlTarget; to: ControlTarget },
  opts: { sessionsDir: string; leadSid: string; now: () => Date },
): SwitchLinesResult {
  const current = state()
  const keyId = controlKeyId(current.secret)
  let sent = 0
  let unreachable = 0
  let failed = 0
  for (const record of records) {
    if (record.status.kind !== "running") continue
    if (record.controlKeyId !== keyId) {
      unreachable++
      continue
    }
    const line = signSwitchLine(deriveControlKey(current.secret, record.sid), {
      seq: ++current.seq,
      ts: opts.now().toISOString(),
      lead: opts.leadSid,
      from: change.from,
      to: change.to,
    })
    try {
      appendControlLine(controlPathFor(opts.sessionsDir, record.sid), JSON.stringify(line))
      sent++
    } catch {
      failed++
    }
  }
  return { sent, unreachable, failed }
}
