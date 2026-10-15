// Shared state interfaces. Types only (plus the whole-token boundary helper). B6 implements
// them, B5 consumes them.

/** Where a span came from. "known-value" wins over "pattern" on a tie. */
export type SpanLayer = "known-value" | "pattern" | "structural"

/** One detected secret or PII span in a text. Offsets are UTF-16 code units, end exclusive. */
export type Span = {
  start: number
  end: number
  ruleId: string
  /** Marker kind ("anthropic.oauth-access", "email"). */
  kind: string
  /** The raw matched value. Never logged, never persisted. */
  value: string
  layer: SpanLayer
}

/** Per-session HMAC key. 32 bytes, held in memory, persisted in a 0600 sidecar by B6. */
export interface SessionKey {
  /** First 8 hex chars of HMAC-SHA256(key, value). Sync (node:crypto). */
  tag(value: string): string
}

/** Origin of a vault entry: the real path of the file read, or a fixed source. */
export type VaultOrigin =
  | { kind: "file"; realPath: string }
  | { kind: "auth.jsonc" }
  | { kind: "env" }
  | { kind: "none" }

export type VaultEntry = { value: string; origin: VaultOrigin }

/** Called once per LRU eviction. Use it to drop derived known values. Must not throw. */
export type VaultEvictHandler = (tag: string, entry: VaultEntry) => void

/** Tag to value store. LRU with a cap (`vault:max_entries`, default 50000). */
export interface Vault {
  put(tag: string, entry: VaultEntry): void
  /** Returns the entry and marks it recently used. */
  get(tag: string): VaultEntry | undefined
  has(tag: string): boolean
  readonly size: number
  readonly maxEntries: number
  /** Total LRU evictions since creation (SecurityStatus store sizes). */
  readonly evictions: number
  /** Optional eviction callback. Set or clear at any time. */
  onEvict?: VaultEvictHandler
}

/**
 * Whole-token boundary: regex char class source for a token char. A known-value hit
 * needs a char outside this class (or the text edge) on each side. No u or v flag.
 * `= . ~ % & ?` are NOT token chars, so `KEY=v`, `v.`, `"v"` and `?a=v&b` all match.
 * `+` and `/` ARE token chars (base64 alphabet), so `path/v` does not match: a value
 * next to them may be a fragment of a longer base64 token. The base64, base64url and
 * URL-encoded forms are indexed on their own.
 */
export const TOKEN_CHAR_CLASS = "[A-Za-z0-9_+/-]"

/** Char-level test for TOKEN_CHAR_CLASS (no regex per call). Keep the two in sync. */
function isTokenChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 || // _
    code === 43 || // +
    code === 47 || // /
    code === 45 // -
  )
}

/**
 * True when text[start, end) is a whole token: a non-empty in-range span with a
 * non-token char (or the text edge) on each side. Pure. B6 uses it for find().
 */
export function isWholeTokenAt(text: string, start: number, end: number): boolean {
  if (start < 0 || end > text.length || start >= end) return false
  if (start > 0 && isTokenChar(text.charCodeAt(start - 1))) return false
  if (end < text.length && isTokenChar(text.charCodeAt(end))) return false
  return true
}

/** Where a known value came from. */
export type KnownValueSource = "harness" | "env" | "vault"

export type KnownValueEntry = {
  value: string
  tag: string
  /** Rule id that floors this value ("secret.known-value.harness", "pii.harness-identity", ...). */
  ruleId: string
  kind: string
  source: KnownValueSource
}

/** Which form of the value matched. */
export type KnownValueEncoding = "raw" | "base64" | "base64url" | "url"

/** One known-value hit. Span.value is the matched text (the encoded form when encoded). */
export type KnownValueHit = Span & {
  /** Tag of the raw value, not of the encoded text. */
  tag: string
  encoding: KnownValueEncoding
  entry: KnownValueEntry
}

export type KnownValueMeta = { ruleId: string; kind: string; source: KnownValueSource }

/**
 * Session known-value index. Each value is indexed raw, base64, base64url, and
 * URL-encoded. Whole-token match only (TOKEN_CHAR_CLASS). Harness and env entries are
 * never evicted. Derived ("vault" source) entries obey maxDerived.
 */
export interface KnownValueIndex {
  /** Adds a value (and its encodings). Values under the floor (min_len 8) are ignored. Returns false then. */
  add(value: string, meta: KnownValueMeta): boolean
  /** Drop one derived entry by tag (vault eviction sync). Harness and env entries stay. */
  removeDerived(tag: string): boolean
  lookupValue(value: string): KnownValueEntry | undefined
  lookupTag(tag: string): KnownValueEntry | undefined
  /** Whole-token occurrences of any indexed value (or encoding) in text, sorted by start. */
  find(text: string): KnownValueHit[]
  readonly size: number
  /** Count of entries by source. */
  sources(): Readonly<Record<KnownValueSource, number>>
  /**
   * Cap on derived entries (`known-value:max_derived`). Default 20000 (SPEC-v3 Bounded
   * stores, core item 1 has landed). setDerivedCap(null) opts out: no cap, no eviction.
   */
  readonly maxDerived: number | null
  setDerivedCap(n: number | null): void
  /** Total derived entries evicted by the maxDerived cap since creation (SecurityStatus). */
  readonly derivedEvictions: number
  /**
   * Add-only reload from one source. Never removes an entry. On failure it keeps all
   * old entries, sets lastLoadError, and returns the error.
   */
  reload(
    source: KnownValueSource,
    load: () => readonly { value: string; meta: KnownValueMeta }[],
  ): { added: number } | { error: string }
  /** Last reload error message (never holds a value), or null after a clean load. */
  readonly lastLoadError: string | null
}

/** Resolved policy. Placeholder: B7 (src/config) owns the real type. */
export type Policy = unknown
