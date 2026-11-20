import { describe, expect, test } from "bun:test"

import {
  DEFAULT_FETCH_MAX_CONCURRENT,
  FETCH_MAX_CONCURRENT_ENV,
  FifoSemaphore,
  oneShotSlots,
  resetOneShotSlotsForTest,
  resolveFetchMaxConcurrent,
  type SlotLease,
} from "./one-shot-slots.ts"

describe("resolveFetchMaxConcurrent", () => {
  test("default is 4", () => {
    expect(DEFAULT_FETCH_MAX_CONCURRENT).toBe(4)
    expect(resolveFetchMaxConcurrent({})).toBe(4)
  })

  test("a valid integer >= 1 sets the cap", () => {
    expect(resolveFetchMaxConcurrent({ [FETCH_MAX_CONCURRENT_ENV]: "1" })).toBe(1)
    expect(resolveFetchMaxConcurrent({ [FETCH_MAX_CONCURRENT_ENV]: " 8 " })).toBe(8)
  })

  test("an invalid value gives the default", () => {
    for (const v of ["", "0", "-2", "2.5", "abc", "1e3", "99999999999999999999"]) {
      expect(resolveFetchMaxConcurrent({ [FETCH_MAX_CONCURRENT_ENV]: v })).toBe(4)
    }
  })

  test("the module semaphore reads the env", () => {
    const saved = process.env[FETCH_MAX_CONCURRENT_ENV]
    try {
      process.env[FETCH_MAX_CONCURRENT_ENV] = "3"
      resetOneShotSlotsForTest()
      expect(oneShotSlots().max).toBe(3)
    } finally {
      if (saved === undefined) delete process.env[FETCH_MAX_CONCURRENT_ENV]
      else process.env[FETCH_MAX_CONCURRENT_ENV] = saved
      resetOneShotSlotsForTest()
    }
  })
})

describe("FifoSemaphore", () => {
  test("rejects a cap below 1", () => {
    expect(() => new FifoSemaphore(0)).toThrow()
  })

  test("cap 4 with 6 calls: 4 start, then 5 and 6 in arrival order", async () => {
    const sem = new FifoSemaphore(4)
    const started: number[] = []
    const leases = new Map<number, SlotLease>()
    const calls = [1, 2, 3, 4, 5, 6].map((n) =>
      sem.acquire().then((lease) => {
        if (!lease) throw new Error("no lease")
        started.push(n)
        leases.set(n, lease)
      }),
    )
    await Bun.sleep(0)
    expect(started).toEqual([1, 2, 3, 4])
    expect(sem.running).toBe(4)
    expect(sem.waiting).toBe(2)

    // Release call 3 first: the first waiter (5) gets the slot, not 6.
    leases.get(3)?.release()
    await Bun.sleep(0)
    expect(started).toEqual([1, 2, 3, 4, 5])
    expect(sem.running).toBe(4)

    leases.get(1)?.release()
    await Promise.all(calls)
    expect(started).toEqual([1, 2, 3, 4, 5, 6])

    for (const lease of leases.values()) lease.release()
    expect(sem.running).toBe(0)
    expect(sem.waiting).toBe(0)
  })

  test("a second release of one lease has no effect", async () => {
    const sem = new FifoSemaphore(1)
    const a = await sem.acquire()
    const b = sem.acquire()
    const c = sem.acquire()
    a?.release()
    a?.release()
    const leaseB = await b
    await Bun.sleep(0)
    // Only one slot moved: c still waits.
    expect(sem.waiting).toBe(1)
    leaseB?.release()
    ;(await c)?.release()
    expect(sem.running).toBe(0)
  })

  test("abort while waiting removes the waiter and releases nothing", async () => {
    const sem = new FifoSemaphore(1)
    const held = await sem.acquire()
    const ac = new AbortController()
    const aborted = sem.acquire(ac.signal)
    const next = sem.acquire()
    expect(sem.waiting).toBe(2)

    ac.abort()
    expect(await aborted).toBeNull()
    expect(sem.waiting).toBe(1)
    // The held slot is not released by the abort.
    expect(sem.running).toBe(1)

    held?.release()
    const leaseNext = await next
    expect(leaseNext).not.toBeNull()
    expect(sem.running).toBe(1)
    leaseNext?.release()
    expect(sem.running).toBe(0)
  })

  test("an aborted signal before acquire gives null and takes no slot", async () => {
    const sem = new FifoSemaphore(1)
    const ac = new AbortController()
    ac.abort()
    expect(await sem.acquire(ac.signal)).toBeNull()
    expect(sem.running).toBe(0)
  })
})
