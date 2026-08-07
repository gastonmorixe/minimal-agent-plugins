import { describe, expect, test } from "bun:test"

import {
  formatTasksOkLine,
  renderTasksAgentBlock,
  renderTasksColumnar,
  renderTasksCompactAck,
  renderTasksToolContent,
} from "./model-render.ts"
import { task } from "./render.fixtures.ts"

// ---------------------------------------------------------------------------
// Columnar body
// ---------------------------------------------------------------------------

describe("renderTasksColumnar", () => {
  test("renders top-level tasks as columnar rows with padded status", () => {
    const out = renderTasksColumnar([
      task({ id: "1", title: "one" }),
      task({ id: "2", status: "doing", title: "two" }),
    ])

    expect(out).toBe(["1  todo      one", "2  doing     two"].join("\n"))
  })

  test("indents subtasks under parent", () => {
    const out = renderTasksColumnar([
      task({ id: "1", title: "parent" }),
      task({ id: "1a", parent: "1", title: "child one" }),
      task({ id: "1b", parent: "1", title: "child two" }),
      task({ id: "2", title: "after" }),
    ])

    expect(out).toBe(
      [
        "1   todo      parent",
        "  1a  todo      child one",
        "  1b  todo      child two",
        "2   todo      after",
      ].join("\n"),
    )
  })

  test("orphaned subtask keeps child indent with its hash", () => {
    const out = renderTasksColumnar([task({ id: "1a", parent: "missing", title: "orphan" })])

    expect(out).toBe("  1a  todo      orphan")
  })

  test("adds trailing duration tokens only when active_ms is non-zero", () => {
    const out = renderTasksColumnar([
      task({ id: "1", title: "done", active_ms: 12_000 }),
      task({ id: "2", title: "fresh" }),
    ])

    expect(out).toBe("1  todo      done  12s\n2  todo      fresh")
  })

  test("escapes task text that could break the <ma::agent::tasks> wrapper", () => {
    const out = renderTasksColumnar([task({ id: "1", title: "use <tag> & keep > quotes" })])

    expect(out).toContain("use &lt;tag&gt; &amp; keep &gt; quotes")
    expect(out).not.toContain("<tag>")
  })

  test("appends canceled reason in parentheses after the title", () => {
    const out = renderTasksColumnar([
      task({ id: "1", status: "canceled", title: "drop this", reason: "user pivoted" }),
    ])

    expect(out).toContain("canceled  drop this (user pivoted)")
  })

  test("empty list renders a compact placeholder", () => {
    expect(renderTasksColumnar([])).toBe("_No tasks._")
  })

  test("renders hash-only rows without position numbers", () => {
    const tasks = Array.from({ length: 12 }, (_, i) =>
      task({ id: `t${String(i).padStart(6, "0")}`, title: `task ${i + 1}` }),
    )
    const out = renderTasksColumnar(tasks)
    const lines = out.split("\n")
    expect(lines).toHaveLength(12)
    expect(lines[9]).toMatch(/^t000009\s+todo\s+task 10$/)
    expect(lines[11]).toMatch(/^t000011\s+todo\s+task 12$/)
    for (const line of lines) {
      expect(line).toMatch(/^/)
      expect(line).not.toMatch(/^\d/)
    }
  })
})

// ---------------------------------------------------------------------------
// Agent block
// ---------------------------------------------------------------------------

describe("renderTasksAgentBlock", () => {
  test("wraps columnar text in <ma::agent::tasks> with action/result/id and counts", () => {
    const out = renderTasksAgentBlock(
      [task({ id: "1", title: "x" })],
      { total: 1, done: 0, doing: 0, todo: 1, canceled: 0 },
      { action: "add", result: "added", id: "1" },
    )

    expect(out).toStartWith(
      `<ma::agent::tasks action="add" result="added" id="1" total="1" done="0" doing="0" todo="1" canceled="0">`,
    )
    expect(out).toContain("1  todo      x")
    expect(out).toEndWith("</ma::agent::tasks>")
  })

  test("escapes attribute values", () => {
    const out = renderTasksAgentBlock(
      [],
      { total: 0, done: 0, doing: 0, todo: 0, canceled: 0 },
      { action: `a"b`, result: "<done>", id: "abc123" },
    )

    expect(out).toContain(`action="a&quot;b"`)
    expect(out).toContain(`result="&lt;done&gt;"`)
    expect(out).toContain(`id="abc123"`)
  })
})

// ---------------------------------------------------------------------------
// Plain-text tool_result (MA-39298)
// ---------------------------------------------------------------------------

describe("formatTasksOkLine / renderTasksToolContent", () => {
  test("OK line carries result, id, and counts without XML", () => {
    const line = formatTasksOkLine(
      { total: 2, done: 0, doing: 1, todo: 1, canceled: 0 },
      { action: "start", result: "started", id: "abcdef" },
    )
    expect(line).toBe("OK started action=start id=abcdef total=2 done=0 doing=1 todo=1 canceled=0")
    expect(line).not.toContain("<")
  })

  test("tool content is OK header plus columnar hashes", () => {
    const out = renderTasksToolContent(
      [task({ id: "1", title: "one" }), task({ id: "2", title: "two" })],
      { total: 2, done: 0, doing: 0, todo: 2, canceled: 0 },
      { action: "add_many", result: "added_many", coerced: ["items"] },
    )
    expect(out).toStartWith("OK added_many action=add_many coerced=items total=2")
    expect(out).toContain("1  todo      one")
    expect(out).toContain("2  todo      two")
    expect(out).not.toContain("ma::agent::tasks")
  })

  test("compact ack is a single OK line", () => {
    const out = renderTasksCompactAck(
      { total: 3, done: 1, doing: 1, todo: 1, canceled: 0 },
      { action: "done", result: "marked_done", id: "aabbcc", parentAutoDone: "aa0000" },
    )
    expect(out).toBe(
      "OK marked_done action=done id=aabbcc parent_auto_done=aa0000 total=3 done=1 doing=1 todo=1 canceled=0",
    )
    expect(out.includes("\n")).toBe(false)
  })
})
