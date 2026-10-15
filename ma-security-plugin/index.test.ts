import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { commands, hooks, tools } from "./index.ts"
import type {
  ChainResult,
  CommandContext,
  SendSnapshot,
  ToolDidBatchPayload,
  ToolWillInvokePayload,
  TUIContext,
  TurnWillStartPayload,
} from "./src/host-types.ts"

const noopLog = {}
const abort = new AbortController().signal

type Listener<T> = (p: T) => unknown

/**
 * Apply chain results like core `HookBus.emitChain`
 * (minimal-agent-core/src/plugins/hooks/hook-bus.ts): falsy is pass-through,
 * a rewrite applies only with a `payload` key, `halt: true` stops the chain.
 */
function runChain<T>(
  payload: T,
  listeners: Listener<T>[],
): { payload: T; halted: boolean; reason?: string } {
  let cur = payload
  for (const l of listeners) {
    const r = l(cur)
    if (!r || typeof r !== "object") continue
    if ("payload" in r) cur = (r as { payload: T }).payload
    if ("halt" in r && (r as { halt: unknown }).halt) {
      const reason = "reason" in r ? String((r as { reason: unknown }).reason) : undefined
      return { payload: cur, halted: true, reason }
    }
  }
  return { payload: cur, halted: false }
}

const send: SendSnapshot = {
  messages: [{ role: "user", content: "hi" }],
  system: "sys",
  model: "fake-model",
}

// Type-level: every hook is typed as a core chain listener.
const typedHooks: {
  "message.willSend": (p: SendSnapshot) => ChainResult<SendSnapshot>
  "tool.willInvoke": (p: ToolWillInvokePayload) => ChainResult<ToolWillInvokePayload>
  "turn.willStart": (p: TurnWillStartPayload) => ChainResult<TurnWillStartPayload>
  "tool.didBatch": (p: ToolDidBatchPayload) => ChainResult<ToolDidBatchPayload>
} = hooks

// Type-level: a bare rewritten payload is not a ChainResult.
// @ts-expect-error bare payload object is not a chain result
const bareResult: ChainResult<SendSnapshot> = send
// @ts-expect-error a listener that returns the bare payload is rejected
const bareHook: (p: SendSnapshot) => ChainResult<SendSnapshot> = (p: SendSnapshot) => p

describe("chain contract", () => {
  test("stub hooks return undefined (pass-through)", () => {
    expect(typedHooks["message.willSend"](send)).toBeUndefined()
    const invoke = { tool: "Bash", toolUseId: "tu_fake", input: { command: "ls" }, cwd: "/fake" }
    expect(hooks["tool.willInvoke"](invoke)).toBeUndefined()
    expect(hooks["turn.willStart"]({ text: "hello" })).toBeUndefined()
    const batch = { results: [{ tool: "Read", toolUseId: "tu_fake", ok: true }] }
    expect(hooks["tool.didBatch"](batch)).toBeUndefined()
    expect(runChain(send, [hooks["message.willSend"]])).toEqual({ payload: send, halted: false })
  })

  test("a {payload} result is applied", () => {
    const rewritten: SendSnapshot = { ...send, system: "redacted" }
    const out = runChain(send, [() => ({ payload: rewritten }), hooks["message.willSend"]])
    expect(out.payload).toBe(rewritten)
    expect(out.halted).toBe(false)
  })

  test("a bare rewritten object is dropped", () => {
    const rewritten: SendSnapshot = { ...send, system: "redacted" }
    expect(runChain(send, [() => rewritten]).payload).toBe(send)
    expect(bareResult as unknown).toBe(send)
    expect(runChain(send, [bareHook]).payload).toBe(send)
  })

  test("halt stops the chain and keeps the reason", () => {
    const after = () => ({ payload: { ...send, model: "never" } })
    const out = runChain(send, [() => ({ halt: true as const, reason: "blocked" }), after])
    expect(out).toEqual({ payload: send, halted: true, reason: "blocked" })
  })
})

describe("skeleton handlers", () => {
  test("SecurityStatus returns the minimal report", () => {
    const ctx: TUIContext = {
      trigger: { type: "tool", name: "SecurityStatus", input: {}, tool_use_id: "tu_fake" },
      packageDir: "/fake",
      cwd: "/fake",
      env: {},
      abort,
      log: noopLog,
    }
    const res = tools.SecurityStatus(ctx)
    expect(res.kind).toBe("tool_result")
    expect(JSON.parse(res.content)).toEqual({ profile: "steer", phase: "skeleton" })
  })

  test("/security returns the same text", () => {
    const ctx: CommandContext = {
      name: "security",
      argv: "",
      rawLine: "/security",
      cwd: "/fake",
      env: {},
      abort,
      log: noopLog,
    }
    const res = commands.security(ctx)
    expect(res).toEqual({ kind: "notice", lines: ['{"profile":"steer","phase":"skeleton"}'] })
  })
})

describe("manifest", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "manifest.json"), "utf8")) as {
    id: string
    enabled: boolean
    hooks: { channel: string; handler: { path: string } }[]
    tuis: { trigger: { tool: { name: string } }; handler: { path: string } }[]
    commands: { name: string; handler: { path: string } }[]
    permissions: string[]
  }

  test("id security, disabled", () => {
    expect(manifest.id).toBe("security")
    expect(manifest.enabled).toBe(false)
  })

  test("declares the four hooks with permissions and existing handler files", () => {
    const channels = manifest.hooks.map((h) => h.channel).sort()
    expect(channels).toEqual(Object.keys(hooks).sort())
    for (const c of channels) expect(manifest.permissions).toContain(`hooks:${c}`)
    const paths = [
      ...manifest.hooks.map((h) => h.handler.path),
      ...manifest.tuis.map((t) => t.handler.path),
      ...manifest.commands.map((c) => c.handler.path),
    ]
    for (const p of paths) expect(Bun.file(join(import.meta.dir, p)).size).toBeGreaterThan(0)
  })

  test("declares SecurityStatus and /security", () => {
    expect(manifest.tuis.map((t) => t.trigger.tool.name)).toEqual(["SecurityStatus"])
    expect(manifest.commands.map((c) => c.name)).toEqual(["security"])
  })
})
