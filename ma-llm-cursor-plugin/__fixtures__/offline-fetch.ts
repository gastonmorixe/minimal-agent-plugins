/**
 * Test helper: a global fetch stub for offline unit tests.
 *
 * @module __fixtures__/offline-fetch
 */
import { afterEach, beforeEach } from "bun:test"

/**
 * Replace the global fetch with a stub that fails at once, for each test.
 *
 * A Cursor Run probes the server config and the live model catalog, and an
 * api-key auth exchanges the key, with the global fetch. A fake NetworkClient
 * does not see these calls. Without this stub a unit test does real HTTPS
 * round trips, and a slow network or proxy makes it slow or time out. The
 * adapter ignores probe failures.
 *
 * Call it inside a `describe`. It returns the URLs that the stub refused in
 * the current test, so a test can check which calls it blocked.
 */
export function useOfflineFetch(): string[] {
  const realFetch = globalThis.fetch
  const refused: string[] = []
  beforeEach(() => {
    refused.length = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      refused.push(input instanceof Request ? input.url : String(input))
      throw new TypeError("offline test: no real network (fetch failed)")
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })
  return refused
}
