/**
 * HTTP hooks end to end (B3 MINOR 5): the engine posts to a local
 * `Bun.serve` on port 0. Native and Claude configs both declare
 * `type: "http"` (native/adapter.ts parseHandler, adapters/claude/adapter.ts
 * parseHandler).
 */

import { join } from "node:path"

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"

import { HooksEngine } from "./engine.ts"
import { makeSandbox, nativeConfig, type Sandbox } from "./test-support.ts"

interface Seen {
  path: string
  method: string
  headers: Record<string, string>
  body: unknown
}

const seen: Seen[] = []
let server: ReturnType<typeof Bun.serve>
let base = ""
/** A URL with no listener: a stopped server's port. */
let deadUrl = ""

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      seen.push({
        path,
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
        body: JSON.parse(await req.text()),
      })
      if (path === "/allow") return Response.json({ decision: "allow" })
      if (path === "/deny") return Response.json({ decision: "deny", reason: "server says no" })
      if (path === "/claude-deny") {
        return Response.json({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "claude server says no",
          },
        })
      }
      if (path === "/slow") await Bun.sleep(2000)
      return new Response("")
    },
  })
  base = `http://127.0.0.1:${server.port}`
  const dead = Bun.serve({ port: 0, fetch: () => new Response("") })
  deadUrl = `http://127.0.0.1:${dead.port}/gone`
  await dead.stop(true)
})

afterAll(async () => {
  await server.stop(true)
})

let sb: Sandbox

beforeEach(() => {
  sb = makeSandbox()
  seen.length = 0
})

afterEach(() => {
  sb.cleanup()
})

const userHooks = () => join(sb.agentHome, "hooks.json")
const claudeSettings = () => join(sb.home, ".claude", "settings.json")

function engine(): HooksEngine {
  return new HooksEngine({
    cwd: sb.project,
    env: { ...sb.env, HOOK_TOKEN: "tok-1", SECRET_KEY: "s3cret" },
  })
}

const bash = (command: string) => ({
  tool: "Bash",
  toolUseId: "tu-1",
  input: { command },
  cwd: sb.project,
  sid: "sid-1",
})

/** True when a dispatch result halts the chain. */
function halted(r: unknown): boolean {
  return typeof r === "object" && r !== null && "halt" in r && r.halt === true
}

/** One native http hook on tool.willInvoke. */
function httpHook(path: string, extra: Record<string, unknown> = {}): string {
  return nativeConfig("tool.willInvoke", [{ type: "http", url: `${base}${path}`, ...extra }])
}

describe("native http hook", () => {
  test("POST body is the native envelope, headers expand only allowed vars", async () => {
    sb.write(
      userHooks(),
      httpHook("/allow", {
        headers: { authorization: "Bearer $HOOK_TOKEN", "x-leak": "[${SECRET_KEY}]" },
        allowedEnvVars: ["HOOK_TOKEN"],
      }),
    )
    const r = await engine().dispatch("tool.willInvoke", bash("ls"))
    expect(halted(r)).toBe(false)
    expect(seen).toHaveLength(1)
    const req = seen[0]
    expect(req?.method).toBe("POST")
    expect(req?.headers["content-type"]).toBe("application/json")
    expect(req?.headers.authorization).toBe("Bearer tok-1")
    expect(req?.headers["x-leak"]).toBe("[]")
    expect(req?.body).toMatchObject({
      channel: "tool.willInvoke",
      payload: { tool: "Bash", toolUseId: "tu-1", input: { command: "ls" } },
      sid: "sid-1",
      cwd: sb.project,
      projectDir: sb.project,
      mode: "default",
    })
  })

  test("a deny response halts with the reason", async () => {
    sb.write(userHooks(), httpHook("/deny"))
    const r = await engine().dispatch("tool.willInvoke", bash("rm -rf /"))
    expect(r).toMatchObject({ halt: true, reason: "server says no" })
  })

  test("a 2xx allow passes", async () => {
    sb.write(userHooks(), httpHook("/allow"))
    const r = await engine().dispatch("tool.willInvoke", bash("ls"))
    expect(halted(r)).toBe(false)
    expect(seen).toHaveLength(1)
  })

  test("a timeout is non-blocking", async () => {
    sb.write(userHooks(), httpHook("/slow", { timeout: 0.2 }))
    const r = await engine().dispatch("tool.willInvoke", bash("ls"))
    expect(halted(r)).toBe(false)
  })

  test("a connection error is non-blocking", async () => {
    sb.write(userHooks(), nativeConfig("tool.willInvoke", [{ type: "http", url: deadUrl }]))
    const r = await engine().dispatch("tool.willInvoke", bash("ls"))
    expect(halted(r)).toBe(false)
  })

  test("failClosed: a timeout or a connection error denies", async () => {
    sb.write(userHooks(), httpHook("/slow", { timeout: 0.2, failClosed: true }))
    const slow = await engine().dispatch("tool.willInvoke", bash("ls"))
    expect(slow).toMatchObject({ halt: true })
    expect(slow && "reason" in slow ? slow.reason : "").toContain("fail closed")

    sb.write(
      userHooks(),
      nativeConfig("tool.willInvoke", [{ type: "http", url: deadUrl, failClosed: true }]),
    )
    const dead = await engine().dispatch("tool.willInvoke", bash("ls"))
    expect(dead).toMatchObject({ halt: true })
  })
})

describe("claude http hook", () => {
  test("PreToolUse http deny halts, body is the Claude envelope", async () => {
    sb.write(
      claudeSettings(),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "http",
                  url: `${base}/claude-deny`,
                  headers: { "x-token": "$HOOK_TOKEN", "x-leak": "$SECRET_KEY" },
                  allowedEnvVars: ["HOOK_TOKEN"],
                },
              ],
            },
          ],
        },
      }),
    )
    const r = await engine().dispatch("tool.willInvoke", bash("rm -rf /"))
    expect(r).toMatchObject({ halt: true, reason: "claude server says no" })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.headers["x-token"]).toBe("tok-1")
    expect(seen[0]?.headers["x-leak"]).toBe("")
    expect(seen[0]?.body).toMatchObject({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
      tool_use_id: "tu-1",
      session_id: "sid-1",
    })
  })

  test("a connection error is non-blocking unless onFailure is block", async () => {
    const write = (extra: Record<string, unknown>) =>
      sb.write(
        claudeSettings(),
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "http", url: deadUrl, ...extra }] }],
          },
        }),
      )
    write({})
    expect(halted(await engine().dispatch("tool.willInvoke", bash("ls")))).toBe(false)
    write({ onFailure: "block" })
    expect(await engine().dispatch("tool.willInvoke", bash("ls"))).toMatchObject({ halt: true })
  })
})
