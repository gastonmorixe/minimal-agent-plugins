/**
 * Spawn test for `transport.ts`: a real OS process, real stdio, no
 * mocking. This is the test the ACP spec (section 12 Phase 1 / section 11)
 * asks be written FIRST, before the real plugin wiring: spawn the process,
 * drive a minimal ACP session (initialize, session/new, a prompt, cancel),
 * and assert every single stdout line is valid ACP-shaped JSON-RPC —
 * nothing else leaks through. Mirrors the proven spike
 * (`research/acp-spike/drive.ts` in the `minimal-agent` umbrella repo).
 *
 * The fixture under test (`__fixtures__/fake-acp-process.ts`) has no real
 * model and no core boot — it exercises `transport.ts` itself, the piece
 * genuinely finished in this pass. The real `host-mode.ts` entry (wired to
 * a live `HostRuntime`) reuses this exact module, so a transport bug here
 * is a transport bug there too.
 *
 * @module transport.spawn.test
 */

import { describe, expect, it } from "bun:test"

const FIXTURE = `${import.meta.dir}/__fixtures__/fake-acp-process.ts`

interface JsonRpcLike {
  readonly jsonrpc?: unknown
  readonly id?: unknown
  readonly method?: unknown
  readonly result?: unknown
  readonly error?: unknown
}

/** Spawns the fixture and gives back a tiny driver: send/waitFor/stdout lines/stop. */
function spawnFixture(env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", FIXTURE], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const lines: string[] = []
  const reader = proc.stdout.getReader()
  const dec = new TextDecoder()
  let buf = ""
  const pump = (async () => {
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
  const waitFor = async (pred: (o: JsonRpcLike) => boolean, ms = 4000): Promise<JsonRpcLike> => {
    const t0 = Date.now()
    for (;;) {
      for (const l of lines) {
        let o: JsonRpcLike
        try {
          o = JSON.parse(l)
        } catch {
          continue // a stray non-JSON line is counted by the purity check, not here
        }
        if (pred(o)) return o
      }
      if (Date.now() - t0 > ms)
        throw new Error(`timeout waiting; stdout so far:\n${lines.join("\n")}`)
      await Bun.sleep(10)
    }
  }
  const finish = async (): Promise<{ exitCode: number; stderr: string }> => {
    void proc.stdin.end()
    const exitCode = await proc.exited
    await pump
    const stderr = await new Response(proc.stderr).text()
    return { exitCode, stderr }
  }
  return { send, waitFor, finish, lines }
}

/** Every stdout line must be a JSON-RPC 2.0 message (the stdout-purity rule). */
function purityViolations(lines: readonly string[]): string[] {
  return lines.filter((l) => {
    try {
      return (JSON.parse(l) as JsonRpcLike).jsonrpc !== "2.0"
    } catch {
      return true
    }
  })
}

describe("ACP transport spawn test", () => {
  it("initializes, opens a session, streams a prompt, and ends with end_turn", async () => {
    const { send, waitFor, finish, lines } = spawnFixture()

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    })
    const init = await waitFor((o) => o.id === 1)
    expect((init.result as { protocolVersion?: number })?.protocolVersion).toBe(1)

    send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: process.cwd(), mcpServers: [] },
    })
    const sess = await waitFor((o) => o.id === 2)
    const sessionId = (sess.result as { sessionId?: string })?.sessionId
    expect(typeof sessionId).toBe("string")

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "hi" }] },
    })
    const reply = await waitFor((o) => o.id === 3)
    expect((reply.result as { stopReason?: string })?.stopReason).toBe("end_turn")

    const updates = lines
      .map((l) => {
        try {
          return JSON.parse(l) as JsonRpcLike
        } catch {
          return {}
        }
      })
      .filter((o) => o.method === "session/update")
    expect(updates.length).toBe(3)

    const { exitCode, stderr } = await finish()
    expect(purityViolations(lines)).toEqual([])
    expect(exitCode).toBe(0)
    expect(stderr).toContain("[fake-acp] prompt received")
  })

  it("answers a cancelled turn with stopReason cancelled, as a normal result (never a JSON-RPC error)", async () => {
    const { send, waitFor, finish, lines } = spawnFixture()
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    })
    await waitFor((o) => o.id === 1)
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: process.cwd(), mcpServers: [] },
    })
    const sess = await waitFor((o) => o.id === 2)
    const sessionId = (sess.result as { sessionId?: string })?.sessionId

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "again" }] },
    })
    await Bun.sleep(30)
    send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })
    const reply = await waitFor((o) => o.id === 3)
    expect((reply.result as { stopReason?: string })?.stopReason).toBe("cancelled")
    expect("error" in reply).toBe(false)

    // The session accepts a new turn after a cancel.
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "once more" }] },
    })
    const reply2 = await waitFor((o) => o.id === 4)
    expect((reply2.result as { stopReason?: string })?.stopReason).toBe("end_turn")

    const { exitCode } = await finish()
    expect(purityViolations(lines)).toEqual([])
    expect(exitCode).toBe(0)
  })

  it("rejects malformed JSON with a parse error and stays alive", async () => {
    const proc = Bun.spawn(["bun", "run", FIXTURE], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    const lines: string[] = []
    const reader = proc.stdout.getReader()
    const dec = new TextDecoder()
    let buf = ""
    const pump = (async () => {
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
    const wait = async (pred: (o: JsonRpcLike) => boolean, ms = 3000): Promise<JsonRpcLike> => {
      const t0 = Date.now()
      for (;;) {
        for (const l of lines) {
          try {
            const o = JSON.parse(l) as JsonRpcLike
            if (pred(o)) return o
          } catch {
            // ignore
          }
        }
        if (Date.now() - t0 > ms) throw new Error("timeout")
        await Bun.sleep(10)
      }
    }
    void proc.stdin.write("{not json\n")
    void proc.stdin.flush()
    const errLine = await wait((o) => isErrorWithCode(o, -32700))
    expect((errLine.error as { code?: number })?.code).toBe(-32700)
    expect(errLine.id).toBeNull()

    void proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "initialize", params: {} })}\n`,
    )
    void proc.stdin.flush()
    const ok = await wait((o) => o.id === 9)
    expect((ok.result as { protocolVersion?: number })?.protocolVersion).toBe(1)

    void proc.stdin.end()
    await proc.exited
    await pump
    expect(purityViolations(lines)).toEqual([])
  })

  it("negative control: a stray human line on stdout makes the purity check fail", async () => {
    const { send, waitFor, finish, lines } = spawnFixture({ ACP_TEST_STRAY_WRITE: "1" })
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    })
    await waitFor((o) => o.id === 1)
    await finish()
    expect(purityViolations(lines).length).toBeGreaterThan(0)
  })
})

function isErrorWithCode(o: JsonRpcLike, code: number): boolean {
  return (
    typeof o.error === "object" && o.error !== null && (o.error as { code?: number }).code === code
  )
}
