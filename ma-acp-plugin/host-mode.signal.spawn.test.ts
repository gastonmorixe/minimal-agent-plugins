/**
 * Spawn test: the real `host-mode.ts` handler in a real OS process
 * (`__fixtures__/host-mode-process.ts`) must exit soon after one SIGTERM,
 * also while a turn runs and stdin stays open.
 *
 * @module host-mode.signal.spawn.test
 */

import { describe, expect, it } from "bun:test"

const FIXTURE = `${import.meta.dir}/__fixtures__/host-mode-process.ts`

function spawnHost() {
  const proc = Bun.spawn(["bun", "run", FIXTURE], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const lines: string[] = []
  const reader = proc.stdout.getReader()
  const dec = new TextDecoder()
  let buf = ""
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value)
      let i: number
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    }
  })()
  const send = (msg: unknown): void => {
    void proc.stdin.write(`${JSON.stringify(msg)}\n`)
    void proc.stdin.flush()
  }
  const reply = async (id: number): Promise<Record<string, unknown>> => {
    const t0 = Date.now()
    for (;;) {
      for (const l of lines) {
        const o = JSON.parse(l) as Record<string, unknown>
        if (o.id === id && o.method === undefined) return o
      }
      if (Date.now() - t0 > 5000) throw new Error(`no reply ${id}; stdout:\n${lines.join("\n")}`)
      await Bun.sleep(10)
    }
  }
  return { proc, send, reply, lines }
}

/** Wait for the process to exit, or give back "timeout" after `ms`. */
async function exitWithin(proc: Bun.Subprocess, ms: number): Promise<number | "timeout"> {
  return Promise.race([proc.exited, Bun.sleep(ms).then(() => "timeout" as const)])
}

describe("host-mode process signals", () => {
  it("exits within 1 s of one SIGTERM while a turn runs and stdin stays open", async () => {
    const h = spawnHost()
    try {
      h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })
      await h.reply(1)
      h.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd() } })
      const sessionId = (await h.reply(2)).result as { sessionId: string }
      h.send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: sessionId.sessionId, prompt: [{ type: "text", text: "wait" }] },
      })
      await Bun.sleep(100)
      h.proc.kill("SIGTERM")
      const t0 = Date.now()
      const code = await exitWithin(h.proc, 1000)
      expect(code).toBe(0)
      expect(Date.now() - t0).toBeLessThan(1000)
      expect((await h.reply(3)).result).toEqual({ stopReason: "cancelled" })
      const stderr = await new Response(h.proc.stderr).text()
      expect(stderr).toContain("closeCalls=1")
    } finally {
      h.proc.kill("SIGKILL")
    }
  })

  it("exits within 1 s of one SIGTERM when idle", async () => {
    const h = spawnHost()
    try {
      h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })
      await h.reply(1)
      h.proc.kill("SIGTERM")
      expect(await exitWithin(h.proc, 1000)).toBe(0)
    } finally {
      h.proc.kill("SIGKILL")
    }
  })
})
