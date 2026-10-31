/**
 * In-process tests for `transport.ts`: id echo rules (JSON-RPC 2.0), the
 * byte-based line size guard, and `idle()` after EOF.
 *
 * @module transport.test
 */

import { describe, expect, it } from "bun:test"

import { createRpcChannel, type RpcHandlers } from "./transport.ts"

function run(input: readonly string[], handlers: RpcHandlers, maxLineBytes?: number) {
  const out: string[] = []
  const channel = createRpcChannel({
    stdin: (async function* () {
      for (const chunk of input) yield chunk
    })(),
    write: (line) => {
      out.push(line)
    },
    handlers,
    ...(maxLineBytes === undefined ? {} : { maxLineBytes }),
  })
  const parsed = async (): Promise<Record<string, unknown>[]> => {
    await channel.closed
    await channel.idle()
    return out.map((l) => JSON.parse(l) as Record<string, unknown>)
  }
  return { channel, parsed }
}

const echo: RpcHandlers = { requests: { echo: (p) => p }, notifications: {} }

describe("transport ids", () => {
  it("echoes the id value as sent: number, string, or null", async () => {
    const { parsed } = run(
      [
        '{"jsonrpc":"2.0","id":1,"method":"echo","params":1}\n',
        '{"jsonrpc":"2.0","id":"a","method":"echo","params":2}\n',
        '{"jsonrpc":"2.0","id":null,"method":"echo","params":3}\n',
        '{"jsonrpc":"2.0","id":null,"method":"nope"}\n',
      ],
      echo,
    )
    const msgs = await parsed()
    expect(msgs).toContainEqual({ jsonrpc: "2.0", id: 1, result: 1 })
    expect(msgs).toContainEqual({ jsonrpc: "2.0", id: "a", result: 2 })
    expect(msgs).toContainEqual({ jsonrpc: "2.0", id: null, result: 3 })
    const notFound = msgs.find((m) => (m.error as { code?: number })?.code === -32601)
    expect(notFound?.id).toBeNull()
  })

  it("answers -32600 with id null for an id that is not a number, string, or null", async () => {
    const { parsed } = run(['{"jsonrpc":"2.0","id":{"x":1},"method":"echo"}\n'], echo)
    expect(await parsed()).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
    ])
  })
})

describe("transport line size guard", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", async () => {
    // 8 x "é" is 8 code units but 16 bytes. The envelope adds more bytes.
    const line = `{"jsonrpc":"2.0","id":1,"method":"echo","params":"${"é".repeat(8)}"}`
    const units = line.length
    const bytes = new TextEncoder().encode(line).length
    expect(bytes).toBeGreaterThan(units)
    const { parsed } = run([`${line}\n`], echo, units)
    expect(await parsed()).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "message too large" } },
    ])
  })

  it("accepts a line exactly at the byte limit", async () => {
    const line = `{"jsonrpc":"2.0","id":1,"method":"echo","params":"${"é".repeat(8)}"}`
    const bytes = new TextEncoder().encode(line).length
    const { parsed } = run([`${line}\n`], echo, bytes)
    expect(await parsed()).toEqual([{ jsonrpc: "2.0", id: 1, result: "é".repeat(8) }])
  })
})

describe("transport idle()", () => {
  it("resolves only after in-flight requests reply", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const out: string[] = []
    const channel = createRpcChannel({
      stdin: (async function* () {
        yield '{"jsonrpc":"2.0","id":1,"method":"slow"}\n'
      })(),
      write: (line) => {
        out.push(line)
      },
      handlers: {
        requests: {
          slow: async () => {
            await gate
            return "done"
          },
        },
        notifications: {},
      },
    })
    await channel.closed
    let idle = false
    const waiting = channel.idle().then(() => {
      idle = true
    })
    await Bun.sleep(10)
    expect(idle).toBe(false)
    release()
    await waiting
    expect(out.map((l) => JSON.parse(l))).toEqual([{ jsonrpc: "2.0", id: 1, result: "done" }])
  })
})

describe("transport request after close", () => {
  it("rejects a request sent after EOF, and sends nothing", async () => {
    const { channel, parsed } = run([], echo)
    await channel.closed
    await expect(channel.request("session/request_permission", {})).rejects.toThrow(
      /channel closed/,
    )
    expect(await parsed()).toEqual([])
  })

  it("rejects a request sent after stop(), and sends nothing", async () => {
    const out: string[] = []
    const channel = createRpcChannel({
      stdin: (async function* () {
        await new Promise(() => {})
        yield ""
      })(),
      write: (line) => {
        out.push(line)
      },
      handlers: echo,
    })
    channel.stop()
    await expect(channel.request("x", {})).rejects.toThrow(/channel stopped/)
    expect(out).toEqual([])
  })
})
