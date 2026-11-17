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
  // The STE rewrite says "stopped" for abandoned and "completed" for finished.
  const CANCELED_RULE = /Use\s+`canceled`\s+for\s+a\s+task\s+that\s+you\s+stopped/
  const DONE_RULE = /`done`\s+for\s+a\s+task\s+that\s+you\s+completed/

  test("has a dedicated rule distinguishing canceled from done", () => {
    // The tool description carries the rule. The status property repeats it.
    expect(TOOL_DESC).toMatch(
      /Use\s+`canceled`\s+for\s+a\s+task\s+that\s+you\s+stopped,\s+and\s+`done`\s+for\s+a\s+task\s+that\s+you\s+completed/,
    )
    expect(STATUS_DESC).toMatch(CANCELED_RULE)
    expect(STATUS_DESC).toMatch(DONE_RULE)
  })

  test("defines canceled = abandoned and done = finished", () => {
    expect(TOOL_DESC).toMatch(CANCELED_RULE)
    expect(TOOL_DESC).toMatch(DONE_RULE)
    expect(STATUS_DESC).toMatch(CANCELED_RULE)
    expect(STATUS_DESC).toMatch(DONE_RULE)
  })

  test("explicitly addresses the phase-header anti-pattern", () => {
    // The wrong inference was: "phase header has no direct work, so
    // cancel it when subtasks are done." The tool description must
    // contradict it by name (a phase header is a parent task).
    expect(TOOL_DESC).toMatch(/parent\s+task\s+is\s+`done`,\s+not\s+`canceled`/i)
  })

  test("notes that parents with all-done children are done, not canceled", () => {
    // Auto-promote is store-owned. The action text must say the store
    // promotes the parent when the last open child closes.
    expect(ACTION_DESC).toMatch(
      /When\s+no\s+subtask\s+is\s+open,\s+the\s+parent\s+becomes\s+`done`\s+automatically/,
    )
    expect(ACTION_DESC).not.toMatch(/does not auto-promote/i)
    expect(ACTION_DESC).not.toMatch(/parent\s+does\s+not\s+become\s+`done`/i)
    // A finished phase header is `done`, never `canceled`.
    expect(TOOL_DESC).toMatch(/completed\s+parent\s+task\s+is\s+`done`/i)
  })

  test("documents parent auto-start", () => {
    expect(ACTION_DESC).toMatch(/`start`: set the task to `doing`\. The parent also starts\./)
    // Partial-completion rollup: the parent stays doing while siblings are open.
    expect(ACTION_DESC).toMatch(/Before that, the parent stays `doing`/)
  })

  test("warns against redundant parent done after last-child auto-promote", () => {
    // Models often call done(last child) and done(parent) in one turn.
    // The tasks property must forbid the second call by name. The re-done
    // hard error is pinned in handlers/task_tool.api-simplify.test.ts.
    expect(TASKS_DESC).toMatch(/do not use `done` on the parent/i)
    expect(TASKS_DESC).toMatch(/the parent becomes `done` automatically/i)
    expect(ACTION_DESC).toMatch(/the parent becomes `done` automatically/i)
  })

  test("recommends parent/subtask structure for multi-phase plans", () => {
    // Tree form via tasks+children (preferred over drip-feed parent: adds).
    expect(TOOL_DESC).toMatch(/`add_many`\s+with\s+`tasks`/)
    expect(TASKS_DESC).toMatch(/The recommended task tree/i)
    expect(TASKS_DESC).toMatch(/`\{title, children\?\}`/)
  })

  test("the do-not rules repeat the canceled-vs-done warning", () => {
    // Belt-and-suspenders: a model that skims the do-not rules in the tool
    // description must also see the warning, and so must the status property.
    expect(TOOL_DESC).toMatch(/Do not use this tool for small work/)
    expect(TOOL_DESC).toMatch(/Do not write the board again as text/)
    const afterRules = TOOL_DESC.slice(TOOL_DESC.indexOf("Do not write the board"))
    expect(afterRules).toMatch(CANCELED_RULE)
    expect(STATUS_DESC).toMatch(CANCELED_RULE)
  })
})
