/**
 * Tests of review N1: two clients share one helper socket. The client orders
 * helpers by the `helperVersion` of the ping, not by the file mtime. The
 * mtime is the build or extract time, so an mtime rule let two sessions stop
 * the helper of the other on each call. All daemon effects are fakes: no
 * daemon runs and no process gets a signal.
 *
 * @module lib/helper-version.test
 */

import { describe, expect, test } from "bun:test"

import {
  ABSENT,
  type BinaryIdentity,
  type EnsureDeps,
  ensureDaemon,
  type PingInfo,
} from "./client.ts"

/** The time of the older file. */
const T = 1_790_000_000.25

/** The helper of a source checkout. */
const CHECKOUT: BinaryIdentity = {
  path: "/repo/ma-computer-use-plugin/native/build/ComputerUseHelper",
  size: 1000,
  mtime: T,
}

/** The helper that a compiled CLI extracts. A new extract gets a fresh mtime. */
const EXTRACT: BinaryIdentity = {
  path: "/support/minimal-agent/helpers/ComputerUseHelper-abc",
  size: 2000,
  mtime: T + 60,
}

/** One client: the binary that it starts, its protocol and its helper version. */
interface Client {
  binary: BinaryIdentity
  protocol: number
  helperVersion: number
}

/** The ping of the helper that `client` starts. */
function helperOf(client: Client, pid: number): PingInfo {
  return {
    protocol: client.protocol,
    helperVersion: client.helperVersion,
    pid,
    binary: client.binary,
  }
}

/** One socket with a fake helper on it, shared by all clients. */
function socket(answer: PingInfo | null) {
  return {
    answer,
    kills: [] as number[],
    spawns: 0,
    nextPid: 500,
  }
}

/** The effects of one client on the shared socket. */
function depsOf(sock: ReturnType<typeof socket>, client: Client): EnsureDeps {
  return {
    sock: "/x.sock",
    socketExists: () => true,
    wait: async () => {},
    probe: async () => (sock.answer === null ? ABSENT : { kind: "answer", info: sock.answer }),
    spawn: () => {
      sock.spawns++
      sock.answer = helperOf(client, sock.nextPid++)
    },
    kill: (pid) => {
      sock.kills.push(pid)
      sock.answer = null
    },
    selfPid: 1000,
    attempts: 3,
    stopTimeoutMs: 500,
    binary: client.binary,
    protocol: client.protocol,
    helperVersion: client.helperVersion,
    oldBinaries: new Set(),
  }
}

describe("N1: two clients on one socket do not fight", () => {
  test("an old client keeps a helper with a newer protocol, also when its own file is newer", async () => {
    const newClient: Client = { binary: CHECKOUT, protocol: 3, helperVersion: 4 }
    const oldClient: Client = { binary: EXTRACT, protocol: 2, helperVersion: 3 }
    const sock = socket(helperOf(newClient, 111))
    expect(await ensureDaemon(depsOf(sock, oldClient))).toEqual({ ok: true })
    expect(sock.kills).toEqual([])
    expect(sock.spawns).toBe(0)
  })

  test("an older-version client keeps a newer-version helper, also when its own file is newer", async () => {
    const newClient: Client = { binary: CHECKOUT, protocol: 2, helperVersion: 4 }
    const oldClient: Client = { binary: EXTRACT, protocol: 2, helperVersion: 3 }
    const sock = socket(helperOf(newClient, 111))
    expect(await ensureDaemon(depsOf(sock, oldClient))).toEqual({ ok: true })
    expect(sock.kills).toEqual([])
    expect(sock.spawns).toBe(0)
  })

  test("a newer-version client replaces an older-version helper, also when that file is newer", async () => {
    const oldClient: Client = { binary: EXTRACT, protocol: 2, helperVersion: 3 }
    const newClient: Client = { binary: CHECKOUT, protocol: 2, helperVersion: 4 }
    const sock = socket(helperOf(oldClient, 111))
    expect(await ensureDaemon(depsOf(sock, newClient))).toEqual({ ok: true })
    expect(sock.kills).toEqual([111])
    expect(sock.spawns).toBe(1)
    expect(sock.answer?.helperVersion).toBe(4)
  })

  test("after a protocol bump, 4 calls of 2 sessions stop a helper only one time", async () => {
    const oldClient: Client = { binary: EXTRACT, protocol: 2, helperVersion: 3 }
    const newClient: Client = { binary: CHECKOUT, protocol: 3, helperVersion: 4 }
    const sock = socket(null)
    for (const client of [oldClient, newClient, oldClient, newClient]) {
      expect(await ensureDaemon(depsOf(sock, client))).toEqual({ ok: true })
    }
    expect(sock.kills.length).toBe(1)
    expect(sock.spawns).toBe(2)
    expect(sock.answer?.protocol).toBe(3)
  })
})
