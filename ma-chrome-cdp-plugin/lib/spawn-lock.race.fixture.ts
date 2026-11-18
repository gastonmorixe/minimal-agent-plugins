/**
 * Test fixture for the stale-lock race: wait (busy) until the epoch ms in
 * argv[3], then try once to take the lock at argv[2]. Print "got" or "none".
 *
 * The process then stays alive until the parent kills it, so the lock keeps a
 * live holder. A holder that exits leaves a dead pid in the lock. A dead pid
 * makes the lock stale again (by design), so a breaker that starts late takes
 * it too, and the parent counts 2 holders where the lock is correct.
 *
 * @module lib/spawn-lock.race.fixture
 */

import { tryAcquireLock } from "./spawn-lock.ts"

const [path, startRaw] = process.argv.slice(2)
const startAt = Number(startRaw)
while (Date.now() < startAt) {
  // busy wait so both breakers start at the same moment
}
const r = tryAcquireLock(path ?? "")
process.stdout.write(r ? "got" : "none")
// Hold the lock until the parent kills this process. The timeout is only a
// backstop, so no orphan stays if the parent dies first.
setTimeout(() => process.exit(0), 60_000)
