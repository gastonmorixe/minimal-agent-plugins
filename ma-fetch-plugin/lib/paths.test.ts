import { homedir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { agentHome } from "./paths.ts"

describe("agentHome", () => {
  // Clear+restore the real env around the process.env-default assertions so an
  // ambient MINIMAL_AGENT_HOME (a live agent, a relocated shell) can't pollute
  // the fallback-shape checks.
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.MINIMAL_AGENT_HOME
    delete process.env.MINIMAL_AGENT_HOME
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.MINIMAL_AGENT_HOME
    else process.env.MINIMAL_AGENT_HOME = saved
  })

  test("MINIMAL_AGENT_HOME wins when set (explicit env arg)", () => {
    expect(agentHome({ MINIMAL_AGENT_HOME: "/srv/ma-home" })).toBe("/srv/ma-home")
  })

  test("trims surrounding whitespace on the override", () => {
    expect(agentHome({ MINIMAL_AGENT_HOME: "  /srv/ma-home  " })).toBe("/srv/ma-home")
  })

  test("falls back to <fallbackHome>/.minimal-agent when override absent", () => {
    expect(agentHome({}, "/home/u")).toBe(join("/home/u", ".minimal-agent"))
  })

  test("whitespace-only override is treated as unset (falls back)", () => {
    expect(agentHome({ MINIMAL_AGENT_HOME: "   " }, "/home/u")).toBe(
      join("/home/u", ".minimal-agent"),
    )
  })

  test("empty-string override is treated as unset (falls back)", () => {
    expect(agentHome({ MINIMAL_AGENT_HOME: "" }, "/home/u")).toBe(join("/home/u", ".minimal-agent"))
  })

  test("default args: reads process.env (cleared) → homedir()/.minimal-agent", () => {
    expect(agentHome()).toBe(join(homedir(), ".minimal-agent"))
  })

  test("default args: honors a process.env override", () => {
    process.env.MINIMAL_AGENT_HOME = "/tmp/ma-reloc-paths"
    expect(agentHome()).toBe("/tmp/ma-reloc-paths")
  })
})
