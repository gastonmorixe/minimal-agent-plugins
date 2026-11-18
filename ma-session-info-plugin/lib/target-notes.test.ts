import { readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import onTargetSwitch from "../handlers/on_target_switch.ts"
import onTurnWillStart from "../handlers/on_turn_will_start.ts"

import { recordSwitch, resetSwitchNotesForTests, takeSwitchNote } from "./target-notes.ts"

afterEach(() => resetSwitchNotesForTests())

const A = {
  providerId: "anthropic",
  credentialName: "plan-2",
  model: "claude-sonnet-5-5",
  effort: "high",
}

describe("the model is told about a target switch at its next turn", () => {
  it("the owner's case: a credential switch with the same model names the credential", () => {
    recordSwitch({ from: A, to: { ...A, credentialName: "plan-3" } })
    expect(takeSwitchNote()).toBe(
      'The user switched the target of this session since your last turn: credential "plan-2" -> "plan-3". ' +
        "Your requests now use it. A new credential or provider has its own quota and account.",
    )
  })

  it("a model-only or effort-only switch says nothing about the account", () => {
    recordSwitch({ from: A, to: { ...A, model: "m2", effort: "low" } })
    const note = takeSwitchNote() ?? ""
    expect(note).toContain('model "claude-sonnet-5-5" -> "m2"')
    expect(note).not.toContain("quota")
  })

  it("names each changed value in the order credential, provider, model, effort", () => {
    recordSwitch({
      from: A,
      to: { providerId: "openai", credentialName: "work", model: "gpt-x", effort: "low" },
    })
    expect(takeSwitchNote()).toContain(
      'credential "plan-2" -> "work", provider "anthropic" -> "openai", model "claude-sonnet-5-5" -> "gpt-x", effort "high" -> "low"',
    )
  })

  it("a value that is not set has words", () => {
    recordSwitch({ from: A, to: { providerId: "anthropic", model: "claude-sonnet-5-5" } })
    expect(takeSwitchNote()).toContain(
      'credential "plan-2" -> the provider default, effort "high" -> the model default',
    )
  })

  it("one line for each turn: a second take gives nothing", () => {
    recordSwitch({ from: A, to: { ...A, model: "m2" } })
    expect(takeSwitchNote()).not.toBeNull()
    expect(takeSwitchNote()).toBeNull()
  })

  it("several switches before the turn give one line from the first to the last target", () => {
    recordSwitch({ from: A, to: { ...A, model: "m2" } })
    recordSwitch({ from: { ...A, model: "m2" }, to: { ...A, model: "m3", effort: "low" } })
    const note = takeSwitchNote() ?? ""
    expect(note).toContain('model "claude-sonnet-5-5" -> "m3"')
    expect(note).toContain('effort "high" -> "low"')
    expect(note).not.toContain("m2")
  })

  it("a switch there and back gives nothing", () => {
    recordSwitch({ from: A, to: { ...A, model: "m2" } })
    recordSwitch({ from: { ...A, model: "m2" }, to: A })
    expect(takeSwitchNote()).toBeNull()
  })

  it("a payload that is not a target pair is ignored", () => {
    recordSwitch(undefined)
    recordSwitch({ from: A })
    recordSwitch({ from: A, to: { model: "" } })
    recordSwitch("x")
    expect(takeSwitchNote()).toBeNull()
  })

  it("the line has names only, never a value that is not a target field", () => {
    recordSwitch({
      from: { ...A, token: "sk-secret" },
      to: { ...A, credentialName: "plan-3", apiKey: "sk-secret" },
    })
    expect(takeSwitchNote()).not.toContain("sk-secret")
  })
})

describe("the two handlers", () => {
  it("target.didSwitch records, turn.willStart gives the line once as additionalContext", () => {
    onTargetSwitch({ payload: { from: A, to: { ...A, credentialName: "plan-3" } } })
    const result = onTurnWillStart({ text: "what changed?" })
    expect(result?.additionalContext).toHaveLength(1)
    expect(result?.additionalContext[0]).toContain('credential "plan-2" -> "plan-3"')
    expect(onTurnWillStart({ text: "next" })).toBeUndefined()
  })

  it("turn.willStart with no switch passes through and never changes the text", () => {
    const result = onTurnWillStart({ text: "hello" })
    expect(result).toBeUndefined()
  })

  it("the manifest wires both, with the permission for the hook", () => {
    const m = JSON.parse(readFileSync(join(import.meta.dir, "..", "manifest.json"), "utf8"))
    expect(m.permissions).toContain("hooks:turn.willStart")
    expect(m.headless.hooks.map((h: { channel: string }) => h.channel)).toEqual(["turn.willStart"])
    expect(m.headless.events.map((e: { on: string }) => e.on)).toEqual(["target.didSwitch"])
  })
})
