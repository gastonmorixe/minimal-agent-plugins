/**
 * Tests for the `agentHome` relocation helper.
 *
 * @module lib/agent-home.test
 */

import { homedir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { agentHome } from "./agent-home.ts"

describe("agentHome", () => {
  test("MINIMAL_AGENT_HOME override wins when set", () => {
    const env = { MINIMAL_AGENT_HOME: "/tmp/ma-reloc" } as NodeJS.ProcessEnv
    expect(agentHome(env, "/home/u")).toBe("/tmp/ma-reloc")
  })

  test("override is trimmed", () => {
    const env = { MINIMAL_AGENT_HOME: "  /tmp/ma-reloc  " } as NodeJS.ProcessEnv
    expect(agentHome(env, "/home/u")).toBe("/tmp/ma-reloc")
  })

  test("blank / whitespace-only override is ignored, falls back", () => {
    const env = { MINIMAL_AGENT_HOME: "   " } as NodeJS.ProcessEnv
    expect(agentHome(env, "/home/u")).toBe("/home/u/.minimal-agent")
  })

  test("falls back to join(fallbackHome, .minimal-agent) when unset", () => {
    const env = {} as NodeJS.ProcessEnv
    expect(agentHome(env, "/home/u")).toBe("/home/u/.minimal-agent")
  })

  test("fallbackHome defaults to OS homedir when not provided", () => {
    const env = {} as NodeJS.ProcessEnv
    expect(agentHome(env)).toBe(join(homedir(), ".minimal-agent"))
  })

  test("empty-string override falls back (|| short-circuit)", () => {
    const env = { MINIMAL_AGENT_HOME: "" } as NodeJS.ProcessEnv
    expect(agentHome(env, "/home/u")).toBe("/home/u/.minimal-agent")
  })
})
