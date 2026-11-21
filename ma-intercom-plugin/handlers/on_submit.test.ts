/**
 * Tests for the `prompt.submitted` activity filter: only human-authored work
 * ("user", "command", "expand", or an absent `source` on older hosts) sets the
 * presence activity label. Injected, recovery and continue prompts do not.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { EventHandlerContext } from "../lib/host-types.ts"
import { readSelfState, selfStatePath } from "../lib/selfstate.ts"

import onSubmit, { activityFromPayload } from "./on_submit.ts"

const SID = "aaaaaaaa-1111-2222-3333-444444444444"

let home: string
let env: Record<string, string>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "intercom-on-submit-"))
  env = { MINIMAL_AGENT_HOME: home }
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

function ctx(payload: unknown): EventHandlerContext {
  return {
    event: "prompt.submitted",
    payload,
    packageDir: "/plugin",
    cwd: "/work",
    env,
    emit: () => {},
    abort: new AbortController().signal,
    stderr: process.stderr,
    agent: { sessionId: SID, pid: process.pid, model: "m", version: "0.1.0" },
  }
}

function activity(): string | null {
  return readSelfState(selfStatePath(SID, env), new Date().toISOString()).activity
}

describe("activityFromPayload source filter", () => {
  it.each(["user", "command", "expand"])("keeps source %s", (source) => {
    expect(activityFromPayload({ text: "fix  the\nauth store", source })).toBe("fix the auth store")
  })

  it("keeps an absent source (older hosts)", () => {
    expect(activityFromPayload({ text: "refactor" })).toBe("refactor")
  })

  it.each(["inject", "recovery", "continue"])("ignores source %s", (source) => {
    expect(activityFromPayload({ text: "intercom: 1 message(s) from x", source })).toBeNull()
  })
})

describe("onSubmit", () => {
  it("records a user prompt as the activity", async () => {
    await onSubmit(ctx({ text: "refactoring the auth store", source: "user" }))
    expect(activity()).toBe("refactoring the auth store")
  })

  it("does not overwrite the activity with injected text", async () => {
    await onSubmit(ctx({ text: "refactoring the auth store", source: "user" }))
    await onSubmit(ctx({ text: "Sub-agent A1 finished", source: "inject" }))
    await onSubmit(ctx({ text: "retry", source: "recovery" }))
    await onSubmit(ctx({ text: "continue", source: "continue" }))
    expect(activity()).toBe("refactoring the auth store")
  })
})
