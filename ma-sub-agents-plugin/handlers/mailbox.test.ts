/**
 * Handler test for `Mailbox`: a `post` must render the sent body in the
 * transcript `display`, not only the "Posted to" acknowledgement.
 *
 * @module sub-agents/handlers/mailbox.test
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { TUIContext } from "../lib/host-types.ts"
import { ENV_LEAD } from "../lib/spawn-plan.ts"

import mailbox from "./mailbox.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mailbox-handler-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function ctx(input: Record<string, unknown>): TUIContext {
  return {
    trigger: { type: "tool", name: "SubAgentsMailbox", input, tool_use_id: "t1" },
    packageDir: "/tmp/fake",
    cwd: "/tmp/fake",
    env: { MINIMAL_AGENT_HOME: dir, [ENV_LEAD]: "lead-sid" },
    abort: new AbortController().signal,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    log: { info() {}, warn() {}, error() {}, debug() {} } as never,
  }
}

describe("Mailbox post", () => {
  it("renders the sent body in the display and the kind in the header", async () => {
    const res = await mailbox(
      ctx({ action: "post", to: "A3", kind: "handoff", body: "stop editing foo.ts" }),
    )
    expect(res.is_error).toBeFalsy()
    expect(res.content).toContain("Posted to A3 as lead.")
    expect(res.display).toContain("stop editing foo.ts")
    expect(res.displayHeader).toContain("[handoff]")
  })

  it("keeps a multi-line body visible", async () => {
    const res = await mailbox(ctx({ action: "post", to: "*", body: "line one\nline two" }))
    expect(res.display).toContain("line one")
    expect(res.display).toContain("line two")
  })
})
