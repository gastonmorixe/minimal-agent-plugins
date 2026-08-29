import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { shutdownPersistentWorker } from "../lib/persistent-worker.ts"

import handler from "./on_agent_will_stop.ts"

interface Manifest {
  hooks?: { id: string; channel?: string; handler?: { path?: string } }[]
  permissions?: string[]
}

const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dir, "../manifest.json"), "utf-8"),
) as Manifest

describe("ma-fetch agent.willStop", () => {
  test("manifest wires shutdown on agent.willStop", () => {
    const hook = MANIFEST.hooks?.find((h) => h.channel === "agent.willStop")
    expect(hook?.id).toBe("on_agent_will_stop")
    expect(hook?.handler?.path).toBe("./handlers/on_agent_will_stop.ts")
    expect(MANIFEST.permissions).toContain("hooks:agent.willStop")
  })

  test("handler is a no-throw shutdown of the process-local worker", () => {
    shutdownPersistentWorker()
    expect(() => handler()).not.toThrow()
  })
})
