/**
 * Test fixture for the stale-lock race: wait (busy) until the epoch ms in
 * argv[3], then try once to take the lock at argv[2]. Print "got" or "none".
 * The lock is never released, so the parent can count the holders.
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
