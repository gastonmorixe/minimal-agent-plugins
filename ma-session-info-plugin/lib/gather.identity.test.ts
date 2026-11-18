/**
 * SessionInfo reads the identity of the session from the handler context
 * (`ctx.agent`, `ctx.env`), not from the process env.
 *
 * Gaston (11-18), the web host: two sessions in one server process. In the
 * cursor session SessionInfo showed "Session: unknown" and the boot default
 * model (deepseek-v4.1-flash / opencode-zen), because it read
 * `process.env.MINIMAL_AGENT_SESSION_ID`, which only the CLI sets.
 */

import { afterEach, describe, expect, it } from "bun:test"

import { gatherSessionInfo } from "./gather.ts"
import type { TUIContext } from "./host-types.ts"

const KEYS = ["MINIMAL_AGENT_SESSION_ID", "MINIMAL_AGENT_VERSION", "MINIMAL_AGENT_MODEL"] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function ctx(extra: Partial<TUIContext> & Record<string, unknown>): TUIContext {
  return {
    trigger: { type: "tool", name: "SessionInfo", input: {}, tool_use_id: "t1" },
    cwd: "/work",
    env: {},
    ...extra,
  } as unknown as TUIContext
}

const LIVE = {
  modelId: "cursor-auto",
  displayName: "Cursor Auto",
  providerId: "cursor",
  contextWindow: 128_000,
  thinking: { adaptive: false, extended: false, interleaved: false },
  pricing: { inputPerMTok: 0, outputPerMTok: 0, cacheWritePerMTok: 0, cacheReadPerMTok: 0 },
}

describe("SessionInfo identity comes from the handler context", () => {
  it("the session id and version come from ctx.agent, with no process env", async () => {
    delete process.env.MINIMAL_AGENT_SESSION_ID
    delete process.env.MINIMAL_AGENT_VERSION
    const snap = await gatherSessionInfo(
      ctx({ agent: { sessionId: "web-sid-2", pid: 1, model: "cursor-auto", version: "0.1.0" } }),
    )
    expect(snap.sessionId).toBe("web-sid-2")
    expect(snap.agentVersion).toBe("0.1.0")
  })

  it("ctx.agent wins over a different process env value (an other session)", async () => {
    process.env.MINIMAL_AGENT_SESSION_ID = "process-uuid"
    const snap = await gatherSessionInfo(
      ctx({ agent: { sessionId: "web-sid-2", pid: 1, model: "m", version: "" } }),
    )
    expect(snap.sessionId).toBe("web-sid-2")
  })

  it("with no ctx.agent, the handler env is used before the process env", async () => {
    process.env.MINIMAL_AGENT_SESSION_ID = "process-uuid"
    const snap = await gatherSessionInfo(ctx({ env: { MINIMAL_AGENT_SESSION_ID: "env-sid" } }))
    expect(snap.sessionId).toBe("env-sid")
  })

  it("the live model-info seam gives the model and provider, not the boot env model", async () => {
    process.env.MINIMAL_AGENT_MODEL = "deepseek-v4.1-flash"
    const snap = await gatherSessionInfo(ctx({ queryModelInfo: () => LIVE }))
    expect(snap.modelId).toBe("cursor-auto")
    expect(snap.providerId).toBe("cursor")
  })

  it("the token counters come from ctx.host.sessionInfo (the session's own)", async () => {
    const tokens = {
      input: 5,
      output: 2,
      cacheRead: 0,
      cacheCreate: 0,
      total: 7,
      turns: 1,
      contextSize: 5,
    }
    const snap = await gatherSessionInfo(
      ctx({
        queryModelInfo: () => LIVE,
        host: {
          sessionInfo: {
            tokens: () => tokens,
            providerInfo: async () => ({}),
          },
        },
      }),
    )
    expect(snap.usage.input).toBe(5)
    expect(snap.turns).toBe(1)
  })
})
