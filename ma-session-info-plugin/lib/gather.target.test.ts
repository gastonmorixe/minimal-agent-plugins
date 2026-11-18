/**
 * SessionInfo reads the LIVE target of the session (`ctx.queryTarget`): the
 * credential and the effort after a `/provider`, `/model` or `/effort`.
 * Gaston (11-18): after "/provider anthropic:anthropic-plan-oauth-3" the
 * model asked "what changed?" and SessionInfo showed no credential, so the
 * model could not see the switch.
 */

import { afterEach, describe, expect, it } from "bun:test"

import { gatherSessionInfo } from "./gather.ts"
import type { TUIContext } from "./host-types.ts"
import { formatSessionInfo } from "./snapshot.ts"

const saved = process.env.MINIMAL_AGENT_EFFORT
afterEach(() => {
  if (saved === undefined) delete process.env.MINIMAL_AGENT_EFFORT
  else process.env.MINIMAL_AGENT_EFFORT = saved
})

function ctx(target: unknown): TUIContext {
  return {
    trigger: { type: "tool", name: "SessionInfo", input: {}, tool_use_id: "t1" },
    cwd: "/work",
    env: {},
    queryTarget: () => target,
  } as unknown as TUIContext
}

describe("SessionInfo and the live target", () => {
  it("shows the credential of the live target", async () => {
    const snap = await gatherSessionInfo(
      ctx({ providerId: "anthropic", credentialName: "plan-3", model: "m", effort: "high" }),
    )
    expect(snap.credentialName).toBe("plan-3")
    expect(formatSessionInfo(snap)).toContain("Credential: plan-3")
  })

  it("takes the effort from the live target, not from the env copy", async () => {
    process.env.MINIMAL_AGENT_EFFORT = "low"
    const snap = await gatherSessionInfo(ctx({ providerId: "p", model: "m", effort: "high" }))
    expect(snap.effort).toBe("high")
  })

  it("a live target with no effort is the model default: no effort is shown", async () => {
    process.env.MINIMAL_AGENT_EFFORT = "medium"
    const snap = await gatherSessionInfo(ctx({ providerId: "p", model: "m" }))
    expect(snap.effort).toBeUndefined()
  })

  it("a host with no live target keeps the old behavior: the env effort, no credential", async () => {
    process.env.MINIMAL_AGENT_EFFORT = "low"
    const snap = await gatherSessionInfo(ctx(undefined))
    expect(snap.effort).toBe("low")
    expect(snap.credentialName).toBeUndefined()
  })

  it("a seam that throws does not fail the tool", async () => {
    const c = {
      ...ctx(undefined),
      queryTarget: () => {
        throw new Error("boom")
      },
    } as unknown as TUIContext
    const snap = await gatherSessionInfo(c)
    expect(snap.credentialName).toBeUndefined()
  })
})
