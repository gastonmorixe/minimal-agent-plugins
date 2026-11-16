/**
 * Drift guard for the Task tool guidance.
 *
 * The tasks plugin has no PROMPT.md now. The rules moved to the Task tool
 * description and to the property descriptions in manifest.json. The model
 * sees them with the tool schema.
 *
 * The guidance keeps the agent from using `canceled` to mean "phase
 * complete". The renderer paints canceled rows in red with strikethrough.
 * That is the opposite of what a finished phase must look like.
 *
 * A real session in May 2026 hit this. Every "PHASE N" top-level task got
 * marked `canceled` with reason "phase header, all subtasks done" once its
 * phase finished. The user saw 7 red strikethrough rows and asked why
 * completed tasks were red. The agent was at fault, not the renderer.
 *
 * This test pins that the guidance is present in the manifest. If you
 * rewrite the manifest text, keep the same warnings or fix this test on
 * purpose. Do not delete both.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

interface Prop {
  description?: string
}
interface TaskToolDef {
  description: string
  input_schema: { properties: Record<string, Prop> }
}

const MANIFEST = JSON.parse(readFileSync(join(import.meta.dir, "..", "manifest.json"), "utf8")) as {
  headless: { tools: { trigger: { tool?: TaskToolDef & { name?: string } } }[] }
}
const TOOL = MANIFEST.headless.tools
  .map((t) => t.trigger.tool)
  .find((t): t is TaskToolDef & { name?: string } => t?.name === "Task")
if (!TOOL) throw new Error("manifest.json declares no Task tool")

const TOOL_DESC = TOOL.description
const PROPS = TOOL.input_schema.properties
const ACTION_DESC = PROPS.action?.description ?? ""
const TASKS_DESC = PROPS.tasks?.description ?? ""
const STATUS_DESC = PROPS.status?.description ?? ""

describe("Task tool description canceled-vs-done guidance", () => {
  test("has a dedicated rule distinguishing canceled from done", () => {
    // The tool description carries the rule. The status property repeats it.
    expect(TOOL_DESC).toMatch(/`canceled`\s+means\s+abandoned\s+and\s+`done`\s+means\s+finished/)
    expect(STATUS_DESC).toMatch(/`canceled`\s+means\s+abandoned\s+and\s+`done`\s+means\s+finished/)
  })

  test("defines canceled = abandoned and done = finished", () => {
    expect(TOOL_DESC).toMatch(/`canceled`\s+means\s+abandoned/i)
    expect(TOOL_DESC).toMatch(/`done`\s+means\s+finished/i)
    expect(STATUS_DESC).toMatch(/`canceled`\s+means\s+abandoned/i)
    expect(STATUS_DESC).toMatch(/`done`\s+means\s+finished/i)
  })

  test("explicitly addresses the phase-header anti-pattern", () => {
    // The wrong inference was: "phase header has no direct work, so
    // cancel it when subtasks are done." The tool description must
    // contradict it by name.
    expect(TOOL_DESC).toMatch(/phase\s+header\s+is\s+`done`,\s+not\s+`canceled`/i)
  })

  test("notes that parents with all-done children are done, not canceled", () => {
    // Auto-promote is store-owned. The action text must say the store
    // promotes the parent when the last open child closes.
    expect(ACTION_DESC).toMatch(/auto-promotes?\s+the\s+parent/i)
    expect(ACTION_DESC).toMatch(/last\s+open\s+child/i)
    expect(ACTION_DESC).not.toMatch(/does not auto-promote/i)
    // A finished phase header is `done`, never `canceled`.
    expect(TOOL_DESC).toMatch(/finished\s+phase\s+header\s+is\s+`done`/i)
  })

  test("documents parent auto-start", () => {
    expect(ACTION_DESC).toMatch(/auto-starts?\s+the\s+parent/i)
    // Partial-completion rollup: the parent stays doing while siblings are open.
    expect(ACTION_DESC).toMatch(/parent stays `doing` while siblings stay open/i)
  })

  test("warns against redundant parent done after last-child auto-promote", () => {
    // Models often call done(last child) and done(parent) in one turn.
    // The tasks property must forbid the second call by name. The re-done
    // hard error is pinned in handlers/task_tool.api-simplify.test.ts.
    expect(TASKS_DESC).toMatch(/do not also call `done` on the parent/i)
    expect(ACTION_DESC).toMatch(/auto-promote/i)
  })

  test("recommends parent/subtask structure for multi-phase plans", () => {
    // Tree form via tasks+children (preferred over drip-feed parent: adds).
    expect(TOOL_DESC).toMatch(/`add_many`\s+with\s+`tasks`/)
    expect(TASKS_DESC).toMatch(/Preferred tree form/i)
    expect(TASKS_DESC).toMatch(/`\{title, children\?\}`/)
  })

  test("the do-not rules repeat the canceled-vs-done warning", () => {
    // Belt-and-suspenders: a model that skims the do-not rules in the tool
    // description must also see the warning, and so must the status property.
    expect(TOOL_DESC).toMatch(/Do not use it for trivial work/)
    expect(TOOL_DESC).toMatch(/Do not echo the board as prose/)
    const afterRules = TOOL_DESC.slice(TOOL_DESC.indexOf("Do not echo"))
    expect(afterRules).toMatch(/`canceled`\s+means\s+abandoned/i)
    expect(STATUS_DESC).toMatch(/pick the verb that matches the intent/i)
  })
})
