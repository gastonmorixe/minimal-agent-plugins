/**
 * End-to-end test of the ACP approval gate: spawn the REAL agent in ACP
 * host mode (`--host-mode acp`), with the sibling CLI checkout, this
 * plugins checkout, an isolated MINIMAL_AGENT_HOME, and a local mock model
 * server (the `generic-endpoint` provider in `openai-chat-completions`
 * format). The mock asks for one `Bash` tool call that writes a marker
 * file, then answers "DONE". So "the tool ran" means "the marker exists".
 *
 * Core's test transport (`MINIMAL_AGENT_TRANSPORT=test`) only returns
 * text, so it cannot script a tool call. The mock server can.
 *
 * Cases: approval off (no permission request on the wire), on + allow
 * (the `tool_call` update goes out before the request), on + reject (tool
 * denied, turn still ends with `end_turn`), on + stdin closed while the
 * request waits (tool denied, clean exit), on + session/cancel with two
 * tool calls (one request only, prompt replies `cancelled` at once), and
 * on + a gate hook that did not load (no tool runs, JSON-RPC -32603 per
 * prompt), on + reject the first of two calls (the second runs, the turn
 * goes on), and approval off + session/cancel while a tool runs (then a
 * new prompt, usage, and an effort switch). Also: on + a short
 * `--approval-timeout-ms` and a client that never answers (that call is
 * denied, the turn goes on), a bad `--approval-timeout-ms` (startup
 * error), and a switch between two registered models (fixture
 * `__fixtures__/two-models-provider`). Every stdout line must be a
 * JSON-RPC 2.0 message, with no ESC (0x1b) byte anywhere.
 *
 * Skips with a printed reason when the sibling `../minimal-agent-cli`
 * checkout (with its installed core) is missing. That CLI must pin a core
 * with the `failClosed` hook flag (core 5b7342c or later).
 *
 * @module acp-host.e2e.test
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

const PLUGINS_ROOT = resolve(import.meta.dir, "..")
const CLI_ROOT = resolve(PLUGINS_ROOT, "..", "minimal-agent-cli")

function skipReason(): string | undefined {
  if (!existsSync(join(CLI_ROOT, "src", "index.ts"))) {
    return `sibling CLI checkout not found at ${CLI_ROOT}`
  }
  if (!existsSync(join(CLI_ROOT, "node_modules", "@minimal-agent", "core"))) {
    return `sibling CLI at ${CLI_ROOT} has no installed core (run bun install there)`
  }
  return undefined
}

const SKIP = skipReason()
if (SKIP) process.stderr.write(`[acp-host.e2e] skipped: ${SKIP}\n`)

/**
 * The command that starts the agent. Since S34 Phase 3 the entry point is
 * the CLI repo's `src/index.ts` (core's copy goes away in Phase 4). Change
 * only this function if the CLI entry moves again (for example to a bin).
 */
function agentCommand(): string[] {
  return ["bun", "run", join(CLI_ROOT, "src", "index.ts")]
}

type Json = Record<string, unknown>

/** What the mock model sends. */
interface MockScript {
  /** Bash calls in the first answer (default 1). With 0, the first answer is DONE. */
  readonly toolCalls?: number
  /** The Bash command of each call (default: append to `marker.txt`). */
  readonly command?: string
}

/** Token counts the mock reports for request `n` (1-based): `prompt_tokens` = 1000 * n. */
const promptTokensOf = (n: number): number => 1000 * n

/**
 * OpenAI chat-completions SSE: the first answer of each prompt asks for
 * `toolCalls` Bash calls (`call_1`, `call_2`, ...), the next answer says
 * DONE. Each answer reports usage ({@link promptTokensOf}). The request
 * bodies are kept in `bodies`.
 */
function startMockModel(script: MockScript = {}) {
  const { toolCalls = 1, command = "echo ran >> marker.txt" } = script
  let requests = 0
  const bodies: Json[] = []
  const sse = (chunks: unknown[]): string =>
    `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`
  const chunk = (delta: unknown, finish: string | null = null) => ({
    id: "c1",
    object: "chat.completion.chunk",
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
  const calls = Array.from({ length: toolCalls }, (_, i) => ({
    index: i,
    id: `call_${i + 1}`,
    type: "function",
    function: { name: "Bash", arguments: JSON.stringify({ command }) },
  }))
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = JSON.parse(await req.text()) as Json
      bodies.push(body)
      requests++
      const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : []
      // A new prompt starts when the last message is the user's text.
      const ask = messages[messages.length - 1]?.role === "user"
      const usage = {
        prompt_tokens: promptTokensOf(requests),
        completion_tokens: 1,
        total_tokens: promptTokensOf(requests) + 1,
      }
      const events =
        ask && toolCalls > 0
          ? [chunk({ role: "assistant", tool_calls: calls }), chunk({}, "tool_calls")]
          : [chunk({ role: "assistant", content: "DONE" }), chunk({}, "stop")]
      events.push({ ...chunk({}, null), choices: [], usage } as unknown as ReturnType<typeof chunk>)
      return new Response(sse(events), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    bodies,
    stop: (): void => {
      void server.stop(true)
    },
  }
}

// One mock model per agent process: each one counts its own rounds.
const models: ReturnType<typeof startMockModel>[] = []
let scratch = ""

beforeAll(() => {
  if (SKIP) return
  scratch = mkdtempSync(join(tmpdir(), "acp-e2e-"))
})

/**
 * Bun keeps its runtime transpiler cache in `$HOME/.bun/install/cache/@t@`.
 * Each agent gets its own HOME, so without this every agent writes a new
 * cache (about 500 files) into the scratch dir. Removing them took more
 * than the 5 s hook limit when the disk was busy. The agent uses the
 * cache of the test process instead.
 */
const BUN_TRANSPILER_CACHE =
  process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ??
  join(homedir(), ".bun", "install", "cache", "@t@")

// The scratch dir now holds only small homes and work dirs. The limit is
// for a slow disk under load, not for normal runs.
afterAll(() => {
  for (const m of models) m.stop()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
}, 60_000)

/** What the fake client does when the agent sends `session/request_permission`. */
type OnPermission =
  | "allow_once"
  | "reject_once"
  | "reject_first"
  | "close_stdin"
  | "cancel"
  | "never_answer"

interface SpawnOptions extends MockScript {
  /** The `--model` id (default `mock-model`, an ad-hoc generic-endpoint model). */
  readonly model?: string
  /** Extra env for the agent process. */
  readonly env?: Record<string, string>
  /** The plugin roots to load (default: this plugins checkout). */
  readonly pluginRoot?: string
}

function spawnAgent(
  name: string,
  hostArgs: readonly string[],
  onPermission: OnPermission,
  options: SpawnOptions = {},
) {
  const home = join(scratch, name, "home")
  const work = join(scratch, name, "work")
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  const model = startMockModel(options)
  models.push(model)
  const proc = Bun.spawn(
    [
      ...agentCommand(),
      "--skip-quota",
      "--provider",
      "generic-endpoint",
      "--endpoint",
      model.url,
      "--format",
      "openai-chat-completions",
      "--auth-type",
      "none",
      "--model",
      options.model ?? "mock-model",
      "--host-mode",
      "acp",
      ...hostArgs,
    ],
    {
      cwd: work,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NODE_ENV: "test",
        HOME: home,
        MINIMAL_AGENT_HOME: join(home, ".minimal-agent"),
        // Load THIS plugins checkout, never a clone from GitHub.
        MINIMAL_AGENT_NO_PLUGIN_SYNC: "1",
        MINIMAL_AGENT_PLUGIN_SIBLINGS: options.pluginRoot ?? PLUGINS_ROOT,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: BUN_TRANSPILER_CACHE,
        // Ask for color: a style leak into stdout must still not happen.
        FORCE_COLOR: "1",
        ...options.env,
      },
    },
  )
  const lines: string[] = []
  // Every raw stdout chunk, for the byte-level ESC check.
  const raw: Uint8Array[] = []
  let stderr = ""
  let asked = 0
  // Time (Date.now) of the session/cancel the fake client sent, if any.
  let cancelledAt: number | undefined
  const send = (msg: unknown): void => {
    void proc.stdin.write(`${JSON.stringify(msg)}\n`)
    void proc.stdin.flush()
  }
  const stdoutDone = (async () => {
    const dec = new TextDecoder()
    let buf = ""
    for await (const bytes of proc.stdout) {
      raw.push(bytes)
      buf += dec.decode(bytes, { stream: true })
      let i: number
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        lines.push(line)
        const msg = JSON.parse(line) as Json
        if (msg.method !== "session/request_permission") continue
        asked++
        if (onPermission === "cancel") {
          // Cancel the turn and never answer the request (a silent client).
          if (cancelledAt === undefined) {
            cancelledAt = Date.now()
            send({
              jsonrpc: "2.0",
              method: "session/cancel",
              params: { sessionId: (msg.params as Json).sessionId },
            })
          }
        } else if (onPermission === "never_answer") {
          // A silent client: no answer, no cancel. Only the gate deadline ends the wait.
        } else if (onPermission === "close_stdin") {
          void proc.stdin.end()
        } else {
          const optionId =
            onPermission === "reject_first"
              ? asked === 1
                ? "reject_once"
                : "allow_once"
              : onPermission
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: { outcome: { outcome: "selected", optionId } },
          })
        }
      }
    }
    if (buf.length > 0) lines.push(buf)
  })()
  const stderrDone = (async () => {
    const dec = new TextDecoder()
    for await (const bytes of proc.stderr) stderr += dec.decode(bytes)
  })()
  const reply = async (id: number): Promise<Json> => {
    const t0 = Date.now()
    for (;;) {
      for (const l of lines) {
        const o = JSON.parse(l) as Json
        if (o.id === id && o.method === undefined) return o
      }
      if (Date.now() - t0 > 30_000) {
        throw new Error(`no reply ${id}; stdout:\n${lines.join("\n")}\nstderr:\n${stderr}`)
      }
      await Bun.sleep(20)
    }
  }
  return {
    proc,
    model,
    send,
    reply,
    lines,
    raw,
    stdoutDone,
    stderrDone,
    stderr: () => stderr,
    cancelledAt: () => cancelledAt,
    marker: join(work, "marker.txt"),
    work,
  }
}

type Agent = ReturnType<typeof spawnAgent>

/** initialize + session/new + one session/prompt. Returns the prompt id. */
async function startTurn(a: Agent): Promise<number> {
  a.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })
  await a.reply(1)
  a.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: a.work, mcpServers: [] } })
  const { sessionId } = (await a.reply(2)).result as { sessionId: string }
  a.send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "go" }] },
  })
  return 3
}

/**
 * End stdin, wait for exit (max 20 s), and check stdout purity: every line
 * is a JSON-RPC 2.0 message, no raw ESC (0x1b) byte, and no ESC in any
 * decoded string (style slots are plain text in host mode).
 */
async function finish(a: Agent): Promise<number> {
  try {
    void a.proc.stdin.end()
  } catch {
    // Already closed (case d).
  }
  const code = await Promise.race([a.proc.exited, Bun.sleep(20_000).then(() => -1)])
  await a.stdoutDone
  for (const line of a.lines) {
    const msg = JSON.parse(line) as Json
    expect(msg.jsonrpc).toBe("2.0")
    expect(JSON.stringify(msg)).not.toContain("\\u001b")
  }
  const escBytes = a.raw.reduce((n, b) => n + b.filter((x) => x === 0x1b).length, 0)
  expect(escBytes).toBe(0)
  return code
}

const updates = (a: Agent): Json[] =>
  a.lines
    .map((l) => JSON.parse(l) as Json)
    .filter((m) => m.method === "session/update")
    .map((m) => (m.params as { update: Json }).update)

const permissionRequests = (a: Agent): Json[] =>
  a.lines.map((l) => JSON.parse(l) as Json).filter((m) => m.method === "session/request_permission")

/**
 * A plugin root like this checkout, but with a broken copy of this plugin.
 * Every other plugin dir and `node_modules` is a symlink to the real one.
 */
function brokenPluginRoot(name: string, breakIt: (pluginDir: string) => void): string {
  const root = join(scratch, name, "plugins")
  mkdirSync(root, { recursive: true })
  for (const entry of readdirSync(PLUGINS_ROOT)) {
    const from = join(PLUGINS_ROOT, entry)
    if (entry === "ma-acp-plugin") {
      cpSync(from, join(root, entry), { recursive: true })
      breakIt(join(root, entry))
    } else if (entry === "node_modules" || entry.startsWith("ma-")) {
      symlinkSync(from, join(root, entry))
    }
  }
  return root
}

/**
 * A plugin root with every real plugin (symlinks) plus the
 * two-models provider fixture, so the session lists `mock-small` and
 * `mock-big`.
 */
function twoModelsPluginRoot(name: string): string {
  const root = join(scratch, name, "plugins")
  mkdirSync(root, { recursive: true })
  for (const entry of readdirSync(PLUGINS_ROOT)) {
    if (entry === "node_modules" || entry.startsWith("ma-")) {
      symlinkSync(join(PLUGINS_ROOT, entry), join(root, entry))
    }
  }
  symlinkSync(
    join(import.meta.dir, "__fixtures__", "two-models-provider"),
    join(root, "ma-llm-two-models-fixture"),
  )
  return root
}

/** Remove the `hooks:tool.willInvoke` grant: core skips the gate hook. */
function dropHookGrant(dir: string): void {
  const path = join(dir, "manifest.json")
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { permissions: string[] }
  manifest.permissions = manifest.permissions.filter((p) => p !== "hooks:tool.willInvoke")
  writeFileSync(path, JSON.stringify(manifest, null, 2))
}

/** Add an import that does not resolve: the hook module fails to load. */
function breakHookImport(dir: string): void {
  const path = join(dir, "permission-hook.ts")
  writeFileSync(path, `import "./no-such-module.ts"\n${readFileSync(path, "utf8")}`)
}

describe.skipIf(SKIP !== undefined)("ACP approval gate, real agent process", () => {
  it("(a) approval off: the tool runs and no permission request goes on the wire", async () => {
    const a = spawnAgent("off", [], "reject_once")
    try {
      const id = await startTurn(a)
      expect((await a.reply(id)).result).toEqual({ stopReason: "end_turn" })
      expect(await finish(a)).toBe(0)
      expect(permissionRequests(a)).toEqual([])
      expect(existsSync(a.marker)).toBe(true)
    } finally {
      a.proc.kill("SIGKILL")
    }
  }, 60_000)

  it("(b) approval on + allow_once: the tool runs", async () => {
    const a = spawnAgent("allow", ["--approval"], "allow_once")
    try {
      const id = await startTurn(a)
      expect((await a.reply(id)).result).toEqual({ stopReason: "end_turn" })
      expect(await finish(a)).toBe(0)
      const reqs = permissionRequests(a)
      expect(reqs).toHaveLength(1)
      // The client must see the tool call before it is asked about it.
      const wire = a.lines.map((l) => JSON.parse(l) as Json)
      const announced = wire.findIndex(
        (m) =>
          m.method === "session/update" &&
          (m.params as { update: Json }).update.sessionUpdate === "tool_call" &&
          (m.params as { update: Json }).update.toolCallId === "call_1",
      )
      const asked = wire.findIndex((m) => m.method === "session/request_permission")
      expect(announced).toBeGreaterThanOrEqual(0)
      expect(announced).toBeLessThan(asked)
      const params = reqs[0]?.params as { toolCall: Json } | undefined
      expect(params?.toolCall).toMatchObject({
        toolCallId: "call_1",
        kind: "execute",
      })
      expect(existsSync(a.marker)).toBe(true)
    } finally {
      a.proc.kill("SIGKILL")
    }
  }, 60_000)

  it("(c) approval on + reject_once: the tool is denied, the turn ends with end_turn", async () => {
    const a = spawnAgent("reject", ["--approval"], "reject_once")
    try {
      const id = await startTurn(a)
      expect((await a.reply(id)).result).toEqual({ stopReason: "end_turn" })
      expect(await finish(a)).toBe(0)
      expect(permissionRequests(a)).toHaveLength(1)
      expect(existsSync(a.marker)).toBe(false)
      const failed = updates(a).find(
        (u) => u.sessionUpdate === "tool_call_update" && u.status === "failed",
      )
      expect(failed?.toolCallId).toBe("call_1")
      expect(JSON.stringify(updates(a))).toContain("denied by the ACP approval gate")
      // The model got the tool error and answered again: the turn went on.
      expect(JSON.stringify(updates(a))).toContain("DONE")
    } finally {
      a.proc.kill("SIGKILL")
    }
  }, 60_000)

  it("(d) approval on + stdin closed while the request waits: denied, clean exit", async () => {
    const a = spawnAgent("eof", ["--approval"], "close_stdin")
    try {
      await startTurn(a)
      // The client closes stdin when the request arrives (see spawnAgent).
      const t0 = Date.now()
      while (permissionRequests(a).length === 0 && Date.now() - t0 < 30_000) await Bun.sleep(20)
      const code = await finish(a)
      expect(code).toBe(0)
      expect(permissionRequests(a)).toHaveLength(1)
      expect(existsSync(a.marker)).toBe(false)
      expect(JSON.stringify(updates(a))).toContain("the approval request failed")
      // EOF also aborts the run, so the prompt still gets its reply.
      expect((await a.reply(3)).result).toEqual({ stopReason: "cancelled" })
    } finally {
      a.proc.kill("SIGKILL")
    }
  }, 60_000)

  it("(e) approval on + session/cancel with 2 tool calls: one request only, cancelled at once", async () => {
    const a = spawnAgent("cancel", ["--approval"], "cancel", { toolCalls: 2 })
    try {
      const id = await startTurn(a)
      const reply = await a.reply(id)
      expect(reply.result).toEqual({ stopReason: "cancelled" })
      const cancelledAt = a.cancelledAt()
      expect(cancelledAt).toBeDefined()
      // The reply comes at once. The gate does not wait for the silent client.
      expect(Date.now() - (cancelledAt ?? 0)).toBeLessThan(1500)
      // Let a late second request show up, if the gate sends one.
      await Bun.sleep(300)
      expect(permissionRequests(a)).toHaveLength(1)
      expect(existsSync(a.marker)).toBe(false)
      expect(await finish(a)).toBe(0)
    } finally {
      a.proc.kill("SIGKILL")
    }
  }, 60_000)

  it("(g) approval on + reject the first of 2 calls: only that call is denied, the turn goes on", async () => {
    const a = spawnAgent("reject-first", ["--approval"], "reject_first", {
      toolCalls: 2,
      command: "echo ran >> marker.txt",
    })
    try {
      const id = await startTurn(a)
      expect((await a.reply(id)).result).toEqual({ stopReason: "end_turn" })
      expect(await finish(a)).toBe(0)
      expect(permissionRequests(a)).toHaveLength(2)
      const finished = updates(a).filter(
        (u) => u.sessionUpdate === "tool_call_update" && u.status !== "in_progress" && u.status,
      )
      expect(finished.map((u) => [u.toolCallId, u.status])).toEqual([
        ["call_1", "failed"],
        ["call_2", "completed"],
      ])
      // Only the second call ran.
      expect(readFileSync(a.marker, "utf8")).toBe("ran\n")
      expect(JSON.stringify(updates(a))).toContain("DONE")
    } finally {
      a.proc.kill("SIGKILL")
    }
  }, 60_000)

  it("(h) session/cancel while a tool runs, then a new prompt, usage, and an effort switch", async () => {
    const a = spawnAgent("cancel-tool", [], "allow_once", {
      command: "sleep 30",
      env: { MINIMAL_AGENT_EFFORT_LEVELS: "low,high" },
    })
    try {
      const id = await startTurn(a)
      const sessionId = ((await a.reply(2)).result as { sessionId: string }).sessionId
      const t0 = Date.now()
      while (
        !updates(a).some(
          (u) => u.sessionUpdate === "tool_call_update" && u.status === "in_progress",
        )
      ) {
        if (Date.now() - t0 > 30_000) throw new Error(`tool never ran: ${a.stderr()}`)
        await Bun.sleep(20)
      }
      const cancelAt = Date.now()
      a.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })
      expect((await a.reply(id)).result).toEqual({ stopReason: "cancelled" })
      // The cancel stops the 30 s sleep at once.
      expect(Date.now() - cancelAt).toBeLessThan(5000)

      a.send({
        jsonrpc: "2.0",
        id: 4,
        method: "session/set_config_option",
        params: { sessionId, configId: "effort", value: "low" },
      })
      const options = ((await a.reply(4)).result as { configOptions: Json[] }).configOptions
      expect(options.find((o) => o.id === "effort")?.currentValue).toBe("low")
      a.send({
        jsonrpc: "2.0",
        id: 5,
        method: "session/set_config_option",
        params: { sessionId, configId: "model", value: "no-such-model" },
      })
      expect(((await a.reply(5)).error as Json | undefined)?.code).toBe(-32602)

      // The session still works after the cancel. The new effort reaches the model.
      const before = a.model.bodies.length
      a.send({
        jsonrpc: "2.0",
        id: 6,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "again" }] },
      })
      // Cancel after the model request arrives (the answer asks for the same sleep).
      while (a.model.bodies.length === before) await Bun.sleep(20)
      a.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })
      expect((await a.reply(6)).result).toEqual({ stopReason: "cancelled" })
      expect(a.model.bodies[before]?.reasoning_effort).toBe("low")
      expect(await finish(a)).toBe(0)

      // usage_update: `used` is the input tokens of ONE request (never a sum
      // over requests), `size` is the context window. Turn 1 reports request 1.
      // Turn 2 reports request 2 only if its answer ended before the cancel.
      const usage = updates(a).filter((u) => u.sessionUpdate === "usage_update")
      expect(usage[0]?.used).toBe(promptTokensOf(1))
      for (const u of usage) {
        expect(typeof u.size).toBe("number")
        expect(u.size as number).toBeGreaterThan(0)
        expect([promptTokensOf(1), promptTokensOf(2)]).toContain(u.used as number)
      }
    } finally {
      a.proc.kill("SIGKILL")
    }
  }, 60_000)

  it("(i) approval on + --approval-timeout-ms 200 + a client that never answers: that call is denied, the turn goes on", async () => {
    const a = spawnAgent("timeout", ["--approval", "--approval-timeout-ms", "200"], "never_answer")
    try {
      const id = await startTurn(a)
      expect((await a.reply(id)).result).toEqual({ stopReason: "end_turn" })
      expect(await finish(a)).toBe(0)
      expect(permissionRequests(a)).toHaveLength(1)
      expect(existsSync(a.marker)).toBe(false)
      const failed = updates(a).find(
        (u) => u.sessionUpdate === "tool_call_update" && u.status === "failed",
      )
      expect(failed?.toolCallId).toBe("call_1")
      expect(JSON.stringify(updates(a))).toContain("no answer within 200 ms")
      // The model got the tool error and answered again: the turn went on.
      expect(JSON.stringify(updates(a))).toContain("DONE")
    } finally {
      a.proc.kill("SIGKILL")
    }
  }, 60_000)

  it("(j) a bad --approval-timeout-ms value: a clear startup error, no stdout, a nonzero exit", async () => {
    const a = spawnAgent(
      "bad-timeout",
      ["--approval", "--approval-timeout-ms", "abc"],
      "allow_once",
    )
    try {
      const code = await finish(a)
      expect(code).not.toBe(0)
      expect(code).not.toBe(-1)
      await a.stderrDone
      expect(a.stderr()).toContain("--approval-timeout-ms must be a positive integer")
      expect(a.lines).toEqual([])
      expect(a.model.bodies).toHaveLength(0)
    } finally {
      a.proc.kill("SIGKILL")
    }
  }, 60_000)

  it("(k) switch to a second model: full list in the reply, no config_option_update, the new model id and window size", async () => {
    const name = "two-models"
    const a = spawnAgent(name, [], "allow_once", {
      toolCalls: 0,
      model: "mock-small",
      pluginRoot: twoModelsPluginRoot(name),
    })
    try {
      const id = await startTurn(a)
      const created = (await a.reply(2)).result as { sessionId: string; configOptions: Json[] }
      const { sessionId } = created
      const modelOption = created.configOptions.find((o) => o.id === "model")
      expect(modelOption?.currentValue).toBe("mock-small")
      const values = ((modelOption?.options ?? []) as Json[]).map((o) => o.value)
      expect(values).toContain("mock-small")
      expect(values).toContain("mock-big")
      expect((await a.reply(id)).result).toEqual({ stopReason: "end_turn" })
      expect(a.model.bodies[0]?.model).toBe("mock-small")
      const sizes = (): unknown[] =>
        updates(a)
          .filter((u) => u.sessionUpdate === "usage_update")
          .map((u) => u.size)
      expect(sizes()).toEqual([32_000])
      const configPushes = (): Json[] =>
        updates(a).filter((u) => u.sessionUpdate === "config_option_update")

      // A switch to the same id is a no-op: same list, no push.
      a.send({
        jsonrpc: "2.0",
        id: 4,
        method: "session/set_config_option",
        params: { sessionId, configId: "model", value: "mock-small" },
      })
      const same = ((await a.reply(4)).result as { configOptions: Json[] }).configOptions
      expect(same).toEqual(created.configOptions)
      expect(configPushes()).toEqual([])

      a.send({
        jsonrpc: "2.0",
        id: 5,
        method: "session/set_config_option",
        params: { sessionId, configId: "model", value: "mock-big" },
      })
      // ACP: the reply holds the complete list with the new model selected.
      // A client change gets no config_option_update (that update is only
      // for changes the agent makes itself).
      const switched = ((await a.reply(5)).result as { configOptions: Json[] }).configOptions
      expect(switched.map((o) => o.id)).toEqual(created.configOptions.map((o) => o.id))
      const newModel = switched.find((o) => o.id === "model")
      expect(newModel?.currentValue).toBe("mock-big")
      expect(newModel?.options).toEqual(modelOption?.options)
      expect(configPushes()).toEqual([])

      const before = a.model.bodies.length
      a.send({
        jsonrpc: "2.0",
        id: 6,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "again" }] },
      })
      expect((await a.reply(6)).result).toEqual({ stopReason: "end_turn" })
      expect(a.model.bodies[before]?.model).toBe("mock-big")
      expect(sizes()).toEqual([32_000, 64_000])
      expect(await finish(a)).toBe(0)
      expect(configPushes()).toEqual([])
    } finally {
      a.proc.kill("SIGKILL")
    }
  }, 60_000)

  for (const [label, breakIt] of [
    ["the hook grant is missing", dropHookGrant],
    ["the hook module fails to import", breakHookImport],
  ] as const) {
    it(`(f) approval on + ${label}: no tool runs, a clear error, the process keeps running`, async () => {
      const name = `broken-${breakIt.name}`
      const a = spawnAgent(name, ["--approval"], "allow_once", {
        pluginRoot: brokenPluginRoot(name, breakIt),
      })
      try {
        const id = await startTurn(a)
        const reply = await a.reply(id)
        expect((reply.error as Json | undefined)?.code).toBe(-32603)
        expect(JSON.stringify(reply)).toContain("approval gate failed to load")
        expect(existsSync(a.marker)).toBe(false)
        // The session stays open: a second prompt gets the same error.
        a.send({
          jsonrpc: "2.0",
          id: 4,
          method: "session/prompt",
          params: {
            sessionId: ((await a.reply(2)).result as { sessionId: string }).sessionId,
            prompt: [{ type: "text", text: "again" }],
          },
        })
        const second = await a.reply(4)
        expect((second.error as Json | undefined)?.code).toBe(-32603)
        expect(JSON.stringify(second)).toContain("approval gate failed to load")
        // No model request was made.
        expect(a.model.bodies).toHaveLength(0)
        expect(await finish(a)).toBe(0)
        await a.stderrDone
        expect(a.stderr()).toContain("approval gate failed to load")
        expect(existsSync(a.marker)).toBe(false)
      } finally {
        a.proc.kill("SIGKILL")
      }
    }, 60_000)
  }
})
