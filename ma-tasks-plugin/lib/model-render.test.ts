import { describe, expect, test } from "bun:test"

import { renderTasksAgentBlock, renderTasksColumnar } from "./model-render.ts"
import { task } from "./render.fixtures.ts"

// ---------------------------------------------------------------------------
// Columnar body
// ---------------------------------------------------------------------------

describe("renderTasksColumnar", () => {
  test("renders top-level tasks as columnar rows with padded status", () => {
    const out = renderTasksColumnar([
      task({ id: "aaaaaa", title: "one" }),
      task({ id: "bbbbbb", status: "doing", title: "two" }),
    ])

    expect(out).toBe(
      ["1  #aaaaaa   todo      one", "2  #bbbbbb   doing     two"].join("\n"),
    )
  })

  test("renders subtasks with parent-number + suffix letter", () => {
    const out = renderTasksColumnar([
      task({ id: "aaaaaa", title: "parent" }),
      task({ id: "aaaaaaa", parent: "aaaaaa", title: "child one" }),
      task({ id: "aaaaaab", parent: "aaaaaa", title: "child two" }),
      task({ id: "bbbbbb", title: "after" }),
    ])

    expect(out).toBe(
      [
        "1   #aaaaaa   todo      parent",
        "1a  #aaaaaaa  todo      child one",
        "1b  #aaaaaab  todo      child two",
        "2   #bbbbbb   todo      after",
      ].join("\n"),
    )
  })

  test("orphaned subtask gets '?' position", () => {
    const out = renderTasksColumnar([
      task({ id: "aaaaaaa", parent: "missing", title: "orphan" }),
    ])

    expect(out).toBe("?  #aaaaaaa  todo      orphan")
  })

  test("adds trailing duration tokens only when active_ms is non-zero", () => {
    const out = renderTasksColumnar([
      task({ id: "aaaaaa", title: "done", active_ms: 12_000 }),
      task({ id: "bbbbbb", title: "fresh" }),
    ])

    expect(out).toBe("1  #aaaaaa   todo      done  12s\n2  #bbbbbb   todo      fresh")
  })

  test("escapes task text that could break the <ma::agent::tasks> wrapper", () => {
    const out = renderTasksColumnar([
      task({ id: "aaaaaa", title: "use <tag> & keep > quotes" }),
    ])

    expect(out).toContain("use &lt;tag&gt; &amp; keep &gt; quotes")
    expect(out).not.toContain("<tag>")
  })

  test("appends canceled reason in parentheses after the title", () => {
    const out = renderTasksColumnar([
      task({ id: "aaaaaa", status: "canceled", title: "drop this", reason: "user pivoted" }),
    ])

    expect(out).toContain("canceled  drop this (user pivoted)")
  })

  test("empty list renders a compact placeholder", () => {
    expect(renderTasksColumnar([])).toBe("_No tasks._")
  })

  test("pads position column for double-digit top-level tasks", () => {
    const tasks = Array.from({ length: 12 }, (_, i) =>
      task({ id: `t${String(i).padStart(6, "0")}`, title: `task ${i + 1}` }),
    )
    const out = renderTasksColumnar(tasks)
    const lines = out.split("\n")
    // Position 10 should be "10" (2 chars), padded to match "12" (2 chars)
    expect(lines[9]).toMatch(/^10 /)
    expect(lines[11]).toMatch(/^12 /)
  })
})

// ---------------------------------------------------------------------------
// Agent block
// ---------------------------------------------------------------------------

describe("renderTasksAgentBlock", () => {
  test("wraps columnar text in <ma::agent::tasks> with action/result/id and counts", () => {
    const out = renderTasksAgentBlock(
      [task({ id: "aaaaaa", title: "x" })],
      { total: 1, done: 0, doing: 0, todo: 1, canceled: 0 },
      { action: "add", result: "added", id: "aaaaaa" },
    )

    expect(out).toStartWith(
      `<ma::agent::tasks action="add" result="added" id="aaaaaa" total="1" done="0" doing="0" todo="1" canceled="0">`,
    )
    expect(out).toContain("1  #aaaaaa   todo      x")
    expect(out).toEndWith("</ma::agent::tasks>")
  })

  test("escapes attribute values", () => {
    const out = renderTasksAgentBlock(
      [],
      { total: 0, done: 0, doing: 0, todo: 0, canceled: 0 },
      { action: `a"b`, result: "<done>", id: "#abc123" },
    )

    expect(out).toContain(`action="a&quot;b"`)
    expect(out).toContain(`result="&lt;done&gt;"`)
    expect(out).toContain(`id="abc123"`)
  })
})
