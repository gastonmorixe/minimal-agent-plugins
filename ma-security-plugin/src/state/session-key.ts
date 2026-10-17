// Per-session HMAC key (SPEC-v3 "Redaction levels", design I item 4a).
// 32 random bytes. Persisted as 64 hex chars in `<sid>.security-key` beside the
// session jsonl, mode 0600. All sidecar IO goes through ./fs.ts (contained to the
// session dir). The key loads only from a regular file (no symlink, no FIFO), owned by
// the current uid, mode exactly 0600, holding exactly 64 lowercase hex chars. Anything
// else is corrupt and replaced. Never chmods, never follows a link. Sync IO only.
// Never throws.

import { createHmac, randomBytes } from "node:crypto"
import { basename, dirname, join } from "node:path"

import { entryKindIn, readRegularFileIn, writeFileIn } from "./fs.ts"
import type { SessionKey } from "./types.ts"

const KEY_BYTES = 32
/** Exactly 64 lowercase hex chars, then an optional single newline. */
const KEY_RE = /^[0-9a-f]{64}\n?$/
const SUFFIX = ".security-key"
/** Fixed reason for a replaced sidecar. Never holds a path or key bytes. */
export const SIDECAR_REPLACED_REASON = "sidecar corrupt, replaced"
/** Fixed reason when the sidecar path holds a symlink, dir or FIFO. It is never replaced. */
export const SIDECAR_NOT_REGULAR_REASON = "sidecar not a regular file, memory key"
/**
 * Fixed reason when the session dir is refused as a root (N3): it is a symlink, not a
 * dir, or owned by another uid. Safe but tags change on each resume. Surface it in
 * SecurityStatus.
 */
export const SIDECAR_DIR_REFUSED_REASON = "session dir refused (symlink or foreign), memory key"

/** How the key was obtained. */
export type SessionKeyStatus =
  /** Read from an existing sidecar (resume). */
  | "loaded"
  /** No sidecar: a new key, written exclusively. */
  | "created"
  /** Corrupt, unsafe or unreadable sidecar: a new key, written over it. */
  | "replaced"
  /** Memory only: no session file, the sidecar write failed, or it is not a regular file. */
  | "memory"

export interface SidecarSessionKey extends SessionKey {
  readonly status: SessionKeyStatus
  /** Sidecar path, or null for a memory-only key. */
  readonly path: string | null
  /** Last IO problem (never holds key bytes), or null. */
  readonly error: string | null
}

/** HMAC function (injectable for tests). Returns lowercase hex of HMAC-SHA256. */
export type HmacFn = (key: Buffer, value: string) => string

const defaultHmac: HmacFn = (key, value) =>
  createHmac("sha256", key).update(value, "utf8").digest("hex")

/** Injected process facts (D12). Defaults read the process at the call edge. */
export type SessionKeyOptions = {
  /** Expected owner uid of the sidecar. Default process.getuid() when it exists, else no check. */
  uid?: number | null
  /** Pid for the temp file name. */
  pid?: number
  /** Test seam only: runs after the "missing" read and before the exclusive create. */
  beforeCreate?: () => void
}

/** `<dir>/<sid>.jsonl` gives `<dir>/<sid>.security-key`. */
export function sidecarPathFor(sessionFile: string): string {
  const base = basename(sessionFile)
  const sid = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base
  return join(dirname(sessionFile), sid + SUFFIX)
}

function errMsg(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code
  if (typeof code === "string") return code
  return e instanceof Error ? e.name : "error"
}

class HmacKey implements SidecarSessionKey {
  readonly #key: Buffer
  readonly #hmac: HmacFn
  readonly status: SessionKeyStatus
  readonly path: string | null
  readonly error: string | null

  constructor(
    key: Buffer,
    status: SessionKeyStatus,
    path: string | null,
    error: string | null,
    hmac: HmacFn = defaultHmac,
  ) {
    this.#key = key
    this.#hmac = hmac
    this.status = status
    this.path = path
    this.error = error
  }

  /** 8 hex chars, or null when the HMAC fails (never a shared fallback tag). */
  tag(value: string): string | null {
    try {
      const hex = this.#hmac(this.#key, value)
      return typeof hex === "string" && /^[0-9a-f]{8}/.test(hex) ? hex.slice(0, 8) : null
    } catch {
      return null
    }
  }
}

const KEY_FILE_CAP = 4096

function defaultUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null
}

/**
 * Read a sidecar. Returns the key, "missing", or "bad". "bad" covers: a symlink, a
 * FIFO or other non-regular file, another owner, a mode other than 0600, and content
 * that is not exactly 64 lowercase hex chars (plus one optional newline).
 */
function readKey(path: string, uid: number | null): Buffer | "missing" | "bad" {
  const r = readRegularFileIn(dirname(path), basename(path), KEY_FILE_CAP)
  // A missing session dir reads as "missing": the write then reports the real problem.
  if ("error" in r) return r.error === "missing" || r.error === "bad root" ? "missing" : "bad"
  const f = r.value
  if (f === undefined) return "bad"
  if (uid !== null && f.uid !== uid) return "bad"
  if (f.mode !== 0o600) return "bad"
  if (!KEY_RE.test(f.text)) return "bad"
  return Buffer.from(f.text.slice(0, 64), "hex")
}

/**
 * Atomic write through fs.ts: temp file in the same dir (mode 0600, "wx"), then link
 * (when `exclusive`, fails on an existing target) or rename (replace). Refuses a
 * symlinked target. Returns null or a fixed error text ("EEXIST" for an existing target).
 */
function writeKey(path: string, key: Buffer, exclusive: boolean, pid?: number): string | null {
  const r = writeFileIn(dirname(path), basename(path), `${key.toString("hex")}\n`, {
    mode: 0o600,
    exclusive,
    ...(pid === undefined ? {} : { pid }),
  })
  if ("ok" in r) return null
  return r.error === "exists" ? "EEXIST" : r.error
}

/** A key from fixed bytes (tests, known-answer checks). Memory only. */
export function sessionKeyFromBytes(key: Buffer, hmac?: HmacFn): SidecarSessionKey {
  return new HmacKey(Buffer.from(key), "memory", null, null, hmac)
}

/** A key held in memory only (no session file). */
export function memorySessionKey(): SidecarSessionKey {
  return new HmacKey(randomBytes(KEY_BYTES), "memory", null, null)
}

/**
 * Open the session key for a session file. Resume reuses the sidecar key. A missing,
 * unreadable, unsafe or corrupt sidecar gives a new key that is then written. Never
 * throws.
 *
 * Replace policy (N4): a REGULAR sidecar that is "bad" (wrong mode, bad content, or
 * owned by another uid) is replaced by an atomic rename. The rename unlinks the old
 * directory entry, so a foreign-owned regular file is replaced, never written through
 * (the session dir is ours). A non-regular sidecar (symlink, dir, FIFO) is never
 * replaced (SIDECAR_NOT_REGULAR_REASON). A refused session dir, for example a symlink,
 * gives a memory key with SIDECAR_DIR_REFUSED_REASON (N3).
 */
export function openSessionKey(
  sessionFile: string | null,
  opts: SessionKeyOptions = {},
): SidecarSessionKey {
  try {
    if (sessionFile === null || sessionFile === "") return memorySessionKey()
    const uid = opts.uid === undefined ? defaultUid() : opts.uid
    const path = sidecarPathFor(sessionFile)
    const got = readKey(path, uid)
    if (got instanceof Buffer) return new HmacKey(got, "loaded", path, null)
    const key = randomBytes(KEY_BYTES)
    if (got === "missing") {
      opts.beforeCreate?.()
      const err = writeKey(path, key, true, opts.pid)
      if (err === null) return new HmacKey(key, "created", path, null)
      if (err === "bad root") return new HmacKey(key, "memory", path, SIDECAR_DIR_REFUSED_REASON)
      if (err === "EEXIST") {
        // Lost a create race: use the winner's key.
        const again = readKey(path, uid)
        if (again instanceof Buffer) return new HmacKey(again, "loaded", path, null)
      }
      return new HmacKey(key, "memory", path, `sidecar write failed: ${err}`)
    }
    // Never replace a non-regular file (symlink, dir, FIFO): memory key, fixed reason.
    if (entryKindIn(dirname(path), basename(path)) !== "file") {
      return new HmacKey(key, "memory", path, SIDECAR_NOT_REGULAR_REASON)
    }
    const err = writeKey(path, key, false, opts.pid)
    if (err !== null) {
      return new HmacKey(key, "memory", path, `sidecar corrupt, write failed: ${err}`)
    }
    // Two processes may both replace: re-read and use the file key (M2 minor race).
    const again = readKey(path, uid)
    const use = again instanceof Buffer ? again : key
    return new HmacKey(use, "replaced", path, SIDECAR_REPLACED_REASON)
  } catch (e) {
    return new HmacKey(randomBytes(KEY_BYTES), "memory", null, `session key: ${errMsg(e)}`)
  }
}

/** Fork: copy the parent key to the child sidecar (exclusive). True on success. Never throws. */
export function copySessionKey(
  fromSessionFile: string,
  toSessionFile: string,
  opts: SessionKeyOptions = {},
): boolean {
  try {
    const uid = opts.uid === undefined ? defaultUid() : opts.uid
    const got = readKey(sidecarPathFor(fromSessionFile), uid)
    if (!(got instanceof Buffer)) return false
    return writeKey(sidecarPathFor(toSessionFile), got, true, opts.pid) === null
  } catch {
    return false
  }
}
