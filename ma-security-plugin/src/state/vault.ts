// Vault: marker tag to {value, origin} (SPEC-v3 "Vault", "Bounded stores").
// LRU with `vault:max_entries` (default 50000). Every put also adds the value to the
// known-value index as a derived ("vault") entry. The index tags with the same session
// key, so the tags match. Plus the pure unified marker rule for Edit and Write.
// Sync only. Never throws out of a public method. Never logs.

import { readUserFileCapped } from "./fs.ts"
import type {
  KnownValueIndex,
  KnownValueMeta,
  Vault,
  VaultEntry,
  VaultEvictHandler,
  VaultOrigin,
} from "./types.ts"

export const DEFAULT_VAULT_MAX_ENTRIES = 50000
/** Content check read cap (SPEC "Read cap"). */
export const VAULT_READ_CAP_BYTES = 4 * 1024 * 1024

/** Rule floor for the derived known value. */
export type VaultFloor = { ruleId: string; kind: string }

const DEFAULT_FLOOR: VaultFloor = { ruleId: "secret.vault-derived", kind: "secret" }

export type VaultOptions = {
  maxEntries?: number
  /**
   * When set, every put also adds the value to this index as derived. The vault then owns
   * derived eviction: it sets the index derived cap to null (N8).
   */
  index?: KnownValueIndex
  onEvict?: VaultEvictHandler
}

class LruVault implements Vault {
  /** Tag to every distinct value seen under it (D13). LRU order is by tag. */
  readonly #map = new Map<string, VaultEntry[]>()
  /** Value to the number of tags that hold it (index sync on eviction). */
  readonly #valueRefs = new Map<string, number>()
  readonly #index: KnownValueIndex | undefined
  readonly maxEntries: number
  #evictions = 0
  #ambiguousTags = 0
  onEvict?: VaultEvictHandler

  constructor(o: VaultOptions) {
    const m = o.maxEntries
    this.maxEntries =
      typeof m === "number" && Number.isFinite(m) && m >= 1
        ? Math.floor(m)
        : DEFAULT_VAULT_MAX_ENTRIES
    this.#index = o.index
    if (o.onEvict !== undefined) this.onEvict = o.onEvict
    // M4, N8: the vault owns eviction of an owned index (it removes by value when the last
    // tag goes). The index cap is off, so a tag collision (more values than tags) never
    // makes the index evict a value the vault still holds.
    try {
      this.#index?.setDerivedCap(null)
    } catch {
      // never throw
    }
  }

  get size(): number {
    return this.#map.size
  }
  get evictions(): number {
    return this.#evictions
  }
  get tagCollisions(): number {
    return this.#ambiguousTags
  }

  /** `floor` is the rule that found the value. It floors the derived known value. */
  put(tag: string, entry: VaultEntry, floor: VaultFloor = DEFAULT_FLOOR): void {
    try {
      if (typeof tag !== "string" || entry === null || typeof entry !== "object") return
      if (typeof entry.value !== "string") return
      const frozen: VaultEntry = Object.freeze({
        value: entry.value,
        origin: Object.freeze({ ...entry.origin }) as VaultOrigin,
      })
      const list = this.#map.get(tag) ?? []
      this.#map.delete(tag)
      const at = list.findIndex((e) => e.value === frozen.value)
      if (at >= 0) list[at] = frozen
      else {
        list.push(frozen)
        this.#valueRefs.set(frozen.value, (this.#valueRefs.get(frozen.value) ?? 0) + 1)
        if (list.length === 2) this.#ambiguousTags++
      }
      this.#map.set(tag, list)
      if (this.#index !== undefined) {
        const meta: KnownValueMeta = { ruleId: floor.ruleId, kind: floor.kind, source: "vault" }
        this.#index.add(frozen.value, meta)
      }
      while (this.#map.size > this.maxEntries) {
        const first = this.#map.entries().next()
        if (first.done) break
        const [oldTag, oldList] = first.value
        this.#map.delete(oldTag)
        if (oldList.length >= 2) this.#ambiguousTags--
        this.#evictions++
        for (const oldEntry of oldList) {
          this.#release(oldEntry.value)
          try {
            this.onEvict?.(oldTag, oldEntry)
          } catch {
            // handler must not throw. Ignore if it does.
          }
        }
      }
    } catch {
      // never throw
    }
  }

  /** Drop one tag reference to a value. The last reference also drops the derived index entry. */
  #release(value: string): void {
    const n = (this.#valueRefs.get(value) ?? 1) - 1
    if (n > 0) {
      this.#valueRefs.set(value, n)
      return
    }
    this.#valueRefs.delete(value)
    try {
      // M5: internal sync. Harness and env entries stay (removeDerivedValue skips them).
      this.#index?.removeDerivedValue(value)
    } catch {
      // never throw
    }
  }

  /** The single entry for a tag, or undefined (unknown or ambiguous). Marks it recently used. */
  get(tag: string): VaultEntry | undefined {
    try {
      const list = this.#map.get(tag)
      if (list === undefined) return undefined
      this.#map.delete(tag)
      this.#map.set(tag, list)
      return list.length === 1 ? list[0] : undefined
    } catch {
      return undefined
    }
  }

  has(tag: string): boolean {
    try {
      return this.#map.has(tag)
    } catch {
      return false
    }
  }

  /** True when the tag holds 2 or more distinct values (D13). No LRU touch. */
  isAmbiguous(tag: string): boolean {
    try {
      return (this.#map.get(tag)?.length ?? 0) >= 2
    } catch {
      return false
    }
  }

  /** File origin with the same real path. Does not touch the LRU order. False when ambiguous. */
  originMatches(tag: string, realPath: string): boolean {
    try {
      const list = this.#map.get(tag)
      const e = list !== undefined && list.length === 1 ? list[0] : undefined
      return e !== undefined && typeof realPath === "string" && isOrigin(e.origin, realPath)
    } catch {
      return false
    }
  }
}

/** New LRU vault. Pass the session index so every put adds a derived known value. */
export function createVault(o: VaultOptions = {}): Vault {
  return new LruVault(o)
}

/** Result of a capped content read. */
export type ReadResult =
  | { kind: "ok"; text: string }
  | { kind: "missing" }
  | { kind: "too-big" }
  | { kind: "error" }

/** Injected reader. Must not throw. Must report "too-big" over maxBytes. */
export type ReadFileFn = (realPath: string, maxBytes: number) => ReadResult

/**
 * Default sync reader with the size cap, through fs.ts readUserFileCapped (one fd, no
 * symlink follow, no FIFO block, cap + 1 bytes at most). Never throws.
 */
export const readFileCapped: ReadFileFn = (realPath, maxBytes) => {
  try {
    const r = readUserFileCapped(realPath, maxBytes)
    if ("ok" in r) return { kind: "ok", text: r.value?.text ?? "" }
    if (r.error === "missing") return { kind: "missing" }
    if (r.error === "too big") return { kind: "too-big" }
    return { kind: "error" }
  } catch {
    return { kind: "error" }
  }
}

export type MarkerReason =
  | "unknown-tag"
  | "unsupported-tool"
  | "not-in-target"
  | "target-missing"
  | "too-big"
  | "read-error"
  | "not-origin"
  /** The tag holds 2 or more distinct values (D13). No swap: fall to the marker autofix. */
  | "ambiguous tag"

export type MarkerResolution = { value: string } | { reason: MarkerReason }

function isOrigin(origin: VaultOrigin, target: string): boolean {
  return origin.kind === "file" && origin.realPath === target
}

/**
 * Unified rule for one vault entry (pure apart from readFile).
 * - Edit: resolves when the value is in the target now, OR the target is the origin.
 * - Write: resolves only when the target is the origin AND it exists AND holds the value.
 * - Known-value origins (auth.jsonc, env) and "none" resolve only by "value in target".
 * - A file over the read cap fails the in-file check.
 * Other tools give "unsupported-tool". Which tools reach here is decided by the caller.
 */
export function resolveEntry(
  entry: VaultEntry | undefined,
  tool: string,
  targetRealPath: string,
  readFile: ReadFileFn = readFileCapped,
  readCapBytes: number = VAULT_READ_CAP_BYTES,
): MarkerResolution {
  try {
    if (entry === undefined) return { reason: "unknown-tag" }
    if (tool !== "Edit" && tool !== "Write") return { reason: "unsupported-tool" }
    const origin = isOrigin(entry.origin, targetRealPath)
    if (tool === "Edit" && origin) return { value: entry.value }
    if (tool === "Write" && !origin) return { reason: "not-origin" }
    const r = readFile(targetRealPath, readCapBytes)
    if (r.kind === "missing") return { reason: "target-missing" }
    if (r.kind === "too-big") return { reason: "too-big" }
    if (r.kind !== "ok") return { reason: "read-error" }
    if (Buffer.byteLength(r.text, "utf8") > readCapBytes) return { reason: "too-big" }
    return r.text.includes(entry.value) ? { value: entry.value } : { reason: "not-in-target" }
  } catch {
    return { reason: "read-error" }
  }
}

/**
 * Unified rule by tag. `vault` is any tag lookup (a Vault or a stub). Marks the entry
 * recently used. An ambiguous tag (D13) gives the reason "ambiguous tag" and no swap.
 * Never throws.
 */
export function resolveMarker(
  vault: Pick<Vault, "get"> & Partial<Pick<Vault, "isAmbiguous">>,
  tag: string,
  tool: string,
  targetRealPath: string,
  readFile: ReadFileFn = readFileCapped,
  readCapBytes: number = VAULT_READ_CAP_BYTES,
): MarkerResolution {
  let entry: VaultEntry | undefined
  try {
    if (vault.isAmbiguous?.(tag) === true) return { reason: "ambiguous tag" }
    entry = vault.get(tag)
  } catch {
    entry = undefined
  }
  return resolveEntry(entry, tool, targetRealPath, readFile, readCapBytes)
}
