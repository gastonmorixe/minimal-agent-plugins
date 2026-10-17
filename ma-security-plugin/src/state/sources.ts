// Known-value sources (SPEC-v3 "Known-value index", E section 6): the harness credential
// file (auth.jsonc) and the environment. Sync file reads only, through fs.ts
// readUserFileCapped (one fd, no symlink follow, capped). Never logs a value.
// Errors carry a fixed message, never file text.

import { parseJsonc } from "../jsonc.ts"

import { readUserFileCapped, userFileStamp } from "./fs.ts"
import { KnownValueLoadError } from "./known-value.ts"
import type { KnownValueIndex, KnownValueMeta } from "./types.ts"

/** Credential file keys whose string values are secrets. */
export const SECRET_KEYS: readonly string[] = [
  "accessToken",
  "refreshToken",
  "idToken",
  "apiKey",
  "api_key",
]

/** Credential file keys whose string values are identity (PII). */
export const IDENTITY_KEYS: readonly string[] = [
  "email",
  "emailAddress",
  "displayName",
  "userFullName",
  "firstName",
  "lastName",
  "givenName",
  "familyName",
  "accountUuid",
  "organizationUuid",
  "accountId",
  "userId",
  "teamId",
  "workosId",
  "principalId",
  "authId",
]

const SECRET_SET = new Set(SECRET_KEYS)
const IDENTITY_SET = new Set(IDENTITY_KEYS)
const EMAIL_KEYS = new Set(["email", "emailAddress"])

/** Env var NAME test: *KEY* *TOKEN* *SECRET* *PASSWORD* *PASSWD* *CREDENTIAL* *AUTH*. */
export const ENV_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i

export const HARNESS_SECRET_META: KnownValueMeta = Object.freeze({
  ruleId: "secret.known-value.harness",
  kind: "credential",
  source: "harness",
})
export const HARNESS_IDENTITY_META: KnownValueMeta = Object.freeze({
  ruleId: "pii.harness-identity",
  kind: "identity",
  source: "harness",
})
export const HARNESS_EMAIL_META: KnownValueMeta = Object.freeze({
  ruleId: "pii.harness-identity",
  kind: "email",
  source: "harness",
})
export const ENV_META: KnownValueMeta = Object.freeze({
  ruleId: "secret.known-value.harness",
  kind: "env",
  source: "env",
})

export type SourceItem = { value: string; meta: KnownValueMeta }

const MAX_DEPTH = 32
/** Credential file read cap. A bigger file is a load failure. */
export const CREDENTIAL_FILE_MAX_BYTES = 4 * 1024 * 1024

/** Walk parsed JSON. Collect string values under the secret and identity key lists. */
export function credentialItems(doc: unknown): SourceItem[] {
  const out: SourceItem[] = []
  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || node === null || typeof node !== "object") return
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1)
      return
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === "string") {
        if (SECRET_SET.has(k)) out.push({ value: v, meta: HARNESS_SECRET_META })
        else if (IDENTITY_SET.has(k)) {
          out.push({
            value: v,
            meta: EMAIL_KEYS.has(k) ? HARNESS_EMAIL_META : HARNESS_IDENTITY_META,
          })
        }
      } else walk(v, depth + 1)
    }
  }
  walk(doc, 0)
  return out
}

/** Read and parse the credential file. Throws KnownValueLoadError (safe message) on failure. */
export function readCredentialItems(path: string): SourceItem[] {
  // One fd through fs.ts: no symlink follow, no FIFO block, cap + 1 bytes at most.
  const r = readUserFileCapped(path, CREDENTIAL_FILE_MAX_BYTES)
  if ("error" in r) {
    if (r.error === "missing") throw new KnownValueLoadError("credential file missing")
    if (r.error === "too big") throw new KnownValueLoadError("credential file too big")
    throw new KnownValueLoadError("credential file unreadable")
  }
  const text = r.value?.text ?? ""
  const doc = parseJsonc(text)
  if (doc === undefined || doc === null || typeof doc !== "object") {
    throw new KnownValueLoadError("credential file parse failed")
  }
  return credentialItems(doc)
}

/** Env values whose name matches ENV_NAME_RE. */
export function envItems(env: Readonly<Record<string, string | undefined>>): SourceItem[] {
  const out: SourceItem[] = []
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && ENV_NAME_RE.test(name)) out.push({ value, meta: ENV_META })
  }
  return out
}

/** Load env values into the index (add-only). The caller passes env (D12). Never throws. */
export function loadEnv(
  index: KnownValueIndex,
  env: Readonly<Record<string, string | undefined>>,
): { added: number } | { error: string } {
  return index.reload("env", () => envItems(env ?? {}))
}

/** Reader for the credential file (injectable for tests). Throws KnownValueLoadError. */
export type CredentialReader = (path: string) => SourceItem[]

/** Stamp of a missing or unstatable file. */
const NO_FILE = "none"

/**
 * Harness credential file watcher. The path is a constructor parameter. refresh() stats
 * the file and reloads (add-only) when mtime, size or inode changed. Every load, clean
 * or failed, records the stamp: a failed load is not re-read on each refresh, only when
 * the stamp changes (a rewrite, or the file appears). The index keeps the last good
 * entries. Never throws.
 */
export class HarnessCredentialSource {
  readonly path: string
  readonly #read: CredentialReader
  #stamp: string | null = null

  constructor(path: string, read: CredentialReader = readCredentialItems) {
    this.path = path
    this.#read = read
  }

  /** "unchanged", or the reload result. */
  refresh(index: KnownValueIndex): "unchanged" | { added: number } | { error: string } {
    const stamp = userFileStamp(this.path) ?? NO_FILE
    if (stamp === this.#stamp) return "unchanged"
    this.#stamp = stamp
    return index.reload("harness", () => this.#read(this.path))
  }
}
