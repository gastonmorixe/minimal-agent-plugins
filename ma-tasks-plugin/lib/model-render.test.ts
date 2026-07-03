import { describe, expect, test } from "bun:test"

import { renderTasksAgentBlock, renderTasksMarkdown } from "./model-render.ts"
import { task } from "./render.fixtures.ts"

// ---------------------------------------------------------------------------
// Markdown body
// ---------------------------------------------------------------------------

describe("renderTasksMarkdown", () => {
  test("renders top-level tasks as Markdown ordered-list items", () => {
    const out = renderTasksMarkdown([
      task({ id: "aaaaaa", title: "one" }),
      task({ id: "bbbbbb", status: "doing", title: "two" }),
    ])

    expect(out).toBe(["1. todo `#aaaaaa` one", "2. doing `#bbbbbb` two"].join("\n"))
  })

  test("renders subtasks as nested ordered-list items with subnumbers", () => {
    const out = renderTasksMarkdown([
      task({ id: "aaaaaa", title: "parent" }),
      task({ id: "aaaaaaa", parent: "aaaaaa", title: "child one" }),
      task({ id: "aaaaaab", parent: "aaaaaa", title: "child two" }),
      task({ id: "bbbbbb", title: "after" }),
    ])

    expect(out).toBe(
      [
        "1. todo `#aaaaaa` parent",
        "   1. todo `#aaaaaaa` child one",
        "   2. todo `#aaaaaab` child two",
        "2. todo `#bbbbbb` after",
      ].join("\n"),
    )
  })

  test("emits canceled reasons as nested Markdown bullets", () => {
    const out = renderTasksMarkdown([
      task({ id: "aaaaaa", status: "canceled", title: "drop this", reason: "user pivoted" }),
    ])

    expect(out).toBe("1. canceled `#aaaaaa` drop this\n   - reason: user pivoted")
  })

  test("adds italic trailing duration tokens only when active_ms is non-zero", () => {
    const out = renderTasksMarkdown([
      task({ id: "aaaaaa", title: "done", active_ms: 12_000 }),
      task({ id: "bbbbbb", title: "fresh" }),
    ])

    expect(out).toBe("1. todo `#aaaaaa` done _12s_\n2. todo `#bbbbbb` fresh")
  })

  test("escapes task text that could break the <ma::agent::tasks> wrapper", () => {
    const out = renderTasksMarkdown([
      task({ id: "aaaaaa", title: "use <tag> & keep > quotes", reason: "ignored" }),
    ])

    expect(out).toContain("use &lt;tag&gt; &amp; keep &gt; quotes")
    expect(out).not.toContain("<tag>")
  })

  test("empty list renders a compact Markdown placeholder", () => {
    expect(renderTasksMarkdown([])).toBe("_No tasks._")
  })
})

// ---------------------------------------------------------------------------
// Agent block
// ---------------------------------------------------------------------------

describe("renderTasksAgentBlock", () => {
  test("wraps Markdown in <ma::agent::tasks> with action/result/id and counts", () => {
    const out = renderTasksAgentBlock(
      [task({ id: "aaaaaa", title: "x" })],
      { total: 1, done: 0, doing: 0, todo: 1, canceled: 0 },
      { action: "add", result: "added", id: "aaaaaa" },
    )

    expect(out).toStartWith(
      `<ma::agent::tasks action="add" result="added" id="aaaaaa" total="1" done="0" doing="0" todo="1" canceled="0">`,
    )
    expect(out).toContain("1. todo `#aaaaaa` x")
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
