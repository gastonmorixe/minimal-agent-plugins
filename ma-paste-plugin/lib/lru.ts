/**
 * A small LRU map with two caps: the number of entries and the total bytes
 * of the values. A set over a cap removes the oldest entries first. A value
 * larger than the byte cap is not kept.
 *
 * The paste files are immutable, so a cached value never becomes stale and
 * the cache has no invalidation.
 *
 * @module lib/lru
 */

/** The caps of a {@link ByteLru}. */
export interface LruCaps {
  /** The maximum total bytes of the values. `0` keeps nothing. */
  maxBytes: number
  /** The maximum number of entries. `0` keeps nothing. */
  maxEntries: number
}

interface Entry<V> {
  value: V
  bytes: number
}

/** An LRU map with an entry cap and a byte cap. */
export class ByteLru<V> {
  private readonly map = new Map<string, Entry<V>>()
  private total = 0

  constructor(private caps: LruCaps) {}

  /** The value of `key`, or undefined. A hit makes the entry the newest. */
  get(key: string): V | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    this.map.delete(key)
    this.map.set(key, e)
    return e.value
  }

  /** Keep `value` (with its size in bytes) as the newest entry. */
  set(key: string, value: V, bytes: number): void {
    this.delete(key)
    if (bytes > this.caps.maxBytes || this.caps.maxEntries <= 0) return
    this.map.set(key, { value, bytes })
    this.total += bytes
    this.evict()
  }

  /** Remove `key`. */
  delete(key: string): void {
    const e = this.map.get(key)
    if (!e) return
    this.map.delete(key)
    this.total -= e.bytes
  }

  /** Remove all entries. */
  clear(): void {
    this.map.clear()
    this.total = 0
  }

  /** Set new caps, and remove the oldest entries over them. */
  setCaps(caps: LruCaps): void {
    this.caps = caps
    this.evict()
  }

  /** The number of entries. */
  get size(): number {
    return this.map.size
  }

  /** The total bytes of the values. */
  get bytes(): number {
    return this.total
  }

  /** True when `key` is in the map. It does not change the order. */
  has(key: string): boolean {
    return this.map.has(key)
  }

  private evict(): void {
    for (const [key, e] of this.map) {
      if (this.map.size <= this.caps.maxEntries && this.total <= this.caps.maxBytes) return
      this.map.delete(key)
      this.total -= e.bytes
    }
  }
}
