/**
 * Local persistence of the cloud access token.
 *
 * The bearer token from {@link DeviceToken} is written to
 * `~/.minimal-agent/cloud-auth.json` (honoring `MINIMAL_AGENT_HOME`), with
 * owner-only permissions (0600) because it is a credential. The RemoteWsTransport
 * and the `ingestRecords`/`submitPrompt` calls read it back to send as
 * `Authorization: Bearer <token>`.
 *
 * Best-effort + atomic: write to a temp sibling then `rename`, so a reader never
 * sees a half-written file; a write failure surfaces as a Result rather than a
 * throw. The file is git-ignored by living under the agent home (outside any
 * repo), never inside the project tree.
 *
 * @module lib/token-store
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** The persisted shape. Versioned so a future format change is detectable. */
export interface StoredAuth {
  readonly v: 1
  readonly accessToken: string
  readonly userId?: string
  /** Unix ms the token was obtained. */
  readonly obtainedAt: number
  /** The auth base URL the token belongs to (so a baseUrl change invalidates it). */
  readonly baseUrl: string
}

/** Resolve the agent home exactly like the rest of minimal-agent (host-published env). */
function homeDir(env: NodeJS.ProcessEnv): string {
  return env.MINIMAL_AGENT_HOME?.trim() || join(homedir(), ".minimal-agent")
}

/** Absolute path to the cloud-auth token file. */
export function cloudAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeDir(env), "cloud-auth.json")
}

/** A Result so callers never have to catch. */
export type StoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string }

/** Persist the token atomically with 0600 perms. */
export function saveAuth(
  auth: StoredAuth,
  env: NodeJS.ProcessEnv = process.env,
): StoreResult<string> {
  const path = cloudAuthPath(env)
  try {
    mkdirSync(homeDir(env), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 })
    // writeFileSync mode is masked by umask on create; force 0600 explicitly.
    try {
      chmodSync(tmp, 0o600)
    } catch {
      // chmod best-effort (e.g. some filesystems); the file is still written.
    }
    renameSync(tmp, path)
    return { ok: true, value: path }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Read the persisted token, or null when absent/corrupt. */
export function loadAuth(env: NodeJS.ProcessEnv = process.env): StoredAuth | null {
  const path = cloudAuthPath(env)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<StoredAuth>
    if (
      raw.v === 1 &&
      typeof raw.accessToken === "string" &&
      raw.accessToken.length > 0 &&
      typeof raw.baseUrl === "string" &&
      typeof raw.obtainedAt === "number"
    ) {
      return {
        v: 1,
        accessToken: raw.accessToken,
        baseUrl: raw.baseUrl,
        obtainedAt: raw.obtainedAt,
        ...(typeof raw.userId === "string" ? { userId: raw.userId } : {}),
      }
    }
    return null
  } catch {
    return null
  }
}

/** True when a usable token is on disk (the de-facto "logged in" signal). */
export function hasAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  return loadAuth(env) !== null
}

/** Remove the persisted token (logout). Best-effort; no-op when absent. */
export function clearAuth(env: NodeJS.ProcessEnv = process.env): void {
  const path = cloudAuthPath(env)
  try {
    if (existsSync(path)) rmSync(path)
  } catch {
    // best-effort
  }
}
