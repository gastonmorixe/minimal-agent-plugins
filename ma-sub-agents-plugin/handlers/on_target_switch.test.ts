/** Tests for the `target.didSwitch` listener: the lead tells its running workers. */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  controlPathFor,
  ENV_TARGET_CONTROL_KEY,
  readSwitchLines,
} from "@minimal-agent/core/plugin-api/utils/target-control"

import type { EventHandlerContext } from "../lib/host-types.ts"
import { SubagentStore } from "../lib/store.ts"
import { childControl, resetLeadControlForTests } from "../lib/target-control-lead.ts"
import type { SubagentRecord } from "../lib/types.ts"

import onTargetSwitch from "./on_target_switch.ts"

const LEAD = "ba0ad20f-1111-4111-8111-111111111111"
const FROM = { credentialName: "full", providerId: "p1", model: "m1", effort: "high" }
const TO = { credentialName: "second", providerId: "p1", model: "m1", effort: "high" }

let dir = ""
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-on-target-switch-"))
  resetLeadControlForTests()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  resetLeadControlForTests()
})

function ctx(
  payload: unknown,
  logs: string[],
  sid: string | undefined = LEAD,
): EventHandlerContext {
  return {
    event: "target.didSwitch",
    payload,
    env: { MINIMAL_AGENT_HOME: dir, MINIMAL_AGENT_SESSIONS_DIR: dir },
    log: {
      info: (m) => logs.push(`info ${m}`),
      warn: (m) => logs.push(`warn ${m}`),
      error: () => {},
      debug: () => {},
    },
    ...(sid ? { agent: { sessionId: sid, pid: 1, model: "m1", version: "0" } } : {}),
  } as EventHandlerContext
}

/** Save a fleet for the lead in the directory the handler resolves. */
function saveFleet(records: SubagentRecord[], sessionsDir: string): void {
  new SubagentStore(LEAD, { dir: sessionsDir }).replaceAll(records)
}

const worker = (sid: string, kind: "running" | "done", controlKeyId?: string): SubagentRecord =>
  ({
    id: sid,
    sid,
    label: sid,
    type: "inline",
    model: "m1",
    task: "t",
    isolation: "fresh",
    workspace: "inherit-cwd",
    spawnedAt: "2026-11-17T00:00:00.000Z",
    status:
      kind === "running"
        ? { kind, pid: 1, startedAt: "2026-11-17T00:00:00.000Z", progress: {} }
        : { kind: "stopped", endedAt: "2026-11-17T00:00:00.000Z" },
    depth: 1,
    leadSid: LEAD,
    ...(controlKeyId !== undefined ? { controlKeyId } : {}),
  }) as unknown as SubagentRecord

describe("on_target_switch", () => {
  it("writes one signed line for each running worker, and says how many", async () => {
    const { resolveSessionsDir } = await import("../lib/runtime.ts")
    const logs: string[] = []
    const context = ctx({ from: FROM, to: TO }, logs)
    const sessionsDir = resolveSessionsDir(context.env)
    const a = childControl(sessionsDir, "child-a")
    saveFleet(
      [worker("child-a", "running", a.keyId), worker("child-done", "done", a.keyId)],
      sessionsDir,
    )

    onTargetSwitch(context)

    const text = readFileSync(controlPathFor(sessionsDir, "child-a"), "utf8")
    const read = readSwitchLines(text, {
      key: a.env[ENV_TARGET_CONTROL_KEY] ?? "",
      lead: LEAD,
      afterSeq: 0,
    })
    expect(read.rejects).toEqual([])
    expect(read.lines).toHaveLength(1)
    expect(read.lines[0]).toMatchObject({ from: FROM, to: TO, lead: LEAD })
    expect(logs).toEqual(["info target switch: 1 running sub-agent(s) got the new target"])
  })

  it("tells the user when a running worker cannot be reached (it started before this lead process)", async () => {
    const { resolveSessionsDir } = await import("../lib/runtime.ts")
    const logs: string[] = []
    const context = ctx({ from: FROM, to: TO }, logs)
    saveFleet([worker("child-old", "running", "0000000000000000")], resolveSessionsDir(context.env))
    onTargetSwitch(context)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("warn target switch: 0 running sub-agent(s) got the new target")
    expect(logs[0]).toContain("1 keep their old target")
  })

  it("does nothing with no fleet, a bad payload, or no lead session id", () => {
    const logs: string[] = []
    onTargetSwitch(ctx({ from: FROM, to: TO }, logs))
    onTargetSwitch(ctx({ from: FROM }, logs))
    onTargetSwitch(ctx({ from: { model: "" }, to: TO }, logs))
    onTargetSwitch(ctx(null, logs))
    onTargetSwitch(ctx({ from: FROM, to: TO }, logs, ""))
    expect(logs).toEqual([])
  })
})
