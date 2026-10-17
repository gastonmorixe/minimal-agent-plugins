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
  /**
   * First 8 hex chars of HMAC-SHA256(key, value). Sync (node:crypto). Null when the
   * HMAC fails (never a shared fallback tag): the caller then uses a bare marker.
   */
  tag(value: string): string | null
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
  /**
   * Keeps every distinct value per tag (D13). Eviction also drops the derived index entry.
   * `floor` is the rule that found the value (ruleId, kind). It floors the derived known
   * value. Default `secret.vault-derived`.
   */
  put(tag: string, entry: VaultEntry, floor?: { ruleId: string; kind: string }): void
  /** Returns the entry and marks it recently used. Undefined for an ambiguous tag (D13). */
  get(tag: string): VaultEntry | undefined
  has(tag: string): boolean
  readonly size: number
  readonly maxEntries: number
  /** Total LRU evictions since creation (SecurityStatus store sizes). */
  readonly evictions: number
  /** Optional eviction callback. Set or clear at any time. */
  onEvict?: VaultEvictHandler
  /**
   * Count of tags that hold 2 or more distinct values (D13). Count only, never a value.
   * An ambiguous tag gives no swap: get() returns undefined for it.
   */
  readonly tagCollisions: number
  /** True when the tag holds 2 or more distinct values (D13). No LRU touch. Never throws. */
  isAmbiguous(tag: string): boolean
  /**
   * True when the tag's entry has a file origin whose real path equals `realPath`.
   * Does not mark the entry recently used. False for an unknown tag. Never throws.
   */
  originMatches(tag: string, realPath: string): boolean
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

/**
 * Match mode (SPEC-v3 "Known-value index", decision D9).
 * - "substring": any position, no boundary check (long random secrets).
 * - "token": whole token. `/` also counts as a boundary for an encoded form with no `/`.
 */
export type KnownValueMode = "substring" | "token"

/** Value class. Identity values always match in token mode. */
export type KnownValueClass = "secret" | "identity"

export type KnownValueEntry = {
  value: string
  /** Session-key tag. Empty string when the HMAC failed (no tag lookup then). */
  tag: string
  /** Rule id that floors this value ("secret.known-value.harness", "pii.harness-identity", ...). */
  ruleId: string
  kind: string
  source: KnownValueSource
  /** Match mode for all 4 encodings of this value (D9). */
  mode: KnownValueMode
  class: KnownValueClass
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

export type KnownValueMeta = {
  ruleId: string
  kind: string
  source: KnownValueSource
  /** Default: "identity" when ruleId starts with "pii.", else "secret". */
  class?: KnownValueClass
}

/**
 * Session known-value index. Each value is indexed raw, base64, base64url, and
 * URL-encoded. Each entry has a match mode (D9): "substring" for long random secrets,
 * "token" (TOKEN_CHAR_CLASS, plus `/` as a boundary for a form with no `/`) for the
 * rest. Harness and env entries are never evicted. Derived ("vault" source) entries
 * obey maxDerived.
 *
 * find() contract:
 * - hits are sorted by start and never overlap
 * - at one start the longest form wins
 * - overlapping hits merge into one hit over the union of their ranges, with the
 *   metadata (entry, encoding, tag) of the longest member, so no part of a value leaks
 * - there is NO marker skip (D16): a value inside `[REDACTED...]` text is still a hit,
 *   so model text cannot shield a value with a bracket. Idempotency comes from add(): a
 *   value that hits a real marker shape (markerSamples) is refused, and a test proves
 *   every renderMarker and markerSamples shape gives zero hits on indexed values
 */
export interface KnownValueIndex {
  /**
   * Adds a value (and its encodings). Returns false for a value under the floor (min_len 8)
   * and for a value that hits a real marker shape (D16). A re-add keeps the stronger mode.
   */
  add(value: string, meta: KnownValueMeta): boolean
  /**
   * Drop one derived entry by tag. Harness and env entries stay. An ambiguous tag
   * (2 or more distinct values) drops nothing: use removeDerivedValue.
   */
  removeDerived(tag: string): boolean
  /** Drop one derived entry by value (vault eviction sync). Harness and env entries stay. */
  removeDerivedValue(value: string): boolean
  lookupValue(value: string): KnownValueEntry | undefined
  /** Entry for a tag. Undefined for an unknown tag or an ambiguous tag (D13). */
  lookupTag(tag: string): KnownValueEntry | undefined
  /** Count of tags that hold 2 or more distinct values (D13). Count only. */
  readonly tagCollisions: number
  /** Occurrences of any indexed value (or encoding) in text. See the find() contract above. */
  find(text: string): KnownValueHit[]
  readonly size: number
  /** Count of entries by source. */
  sources(): Readonly<Record<KnownValueSource, number>>
  /** Count of entries by match mode (SecurityStatus). */
  modes(): Readonly<Record<KnownValueMode, number>>
  /**
   * Cap on derived entries (`known-value:max_derived`). Default 50000, equal to the vault
   * cap so the two never drift (M4). setDerivedCap(null) opts out: no cap, no eviction.
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
