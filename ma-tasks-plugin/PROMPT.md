# Tasks

Use `Task` to plan and track multi-step work the user can watch in real time. The live board is injected every user turn as a `<ma::agent::tasks>` block. Every task has one stable canonical id such as `1`, `2`, `1a`, or `2b`. Tool results are plain text and always begin with an `OK ...` acknowledgement. You do not need to `list` every turn.

## When to use

- **Use it** for 3+ steps the user should see as a plan, or when they ask for a plan.
- Nest with `parent` / `children` for real phases (depth 2 max).

## When not to use

- Trivial 1-2 step work.
- Lessons-learned -> `memory`. Transient notes -> `short-term` memory.

## Workflow

1. **Plan once.** Prefer:

   ```
   Task({ action: "add_many", tasks: [
     { title: "Phase 1: Setup", children: ["step a", "step b"] },
     { title: "Phase 2: Ship" }
   ]})
   ```

   Aliases (same call, pick one): `items` (= `tasks`), or flat `titles: string[]`. `add_many` always extends the current board.
   To abandon the current board and create a new plan, use `replace_plan` with the same `tasks`, `items`, or `titles` shape. Replacement is explicit and atomic.

2. **Start, then work.** `Task({ action: "start", id: "1a" })` using the exact id from the latest tool result or turn attachment. Starting a child auto-starts its parent. Multiple `doing` rows are fine.

3. **Done when finished.** `Task({ action: "done", id: "1a" })`. Completing a child while siblings remain open keeps the parent `doing`; the last open child auto-promotes the parent (and may return `all_done`). **Never also `done` the parent** - that is a hard error if the parent is already done.

4. **Mid-flight substeps.** `Task({ action: "add", title: "...", parent: "1" })` then `start` the child id from that tool result.

5. **Redirects.** Never-started -> `remove`. In-flight / abandoned -> `status: "canceled"` with a one-line `reason`.

## Ids

The board shows one canonical stable id per task. Roots use monotonic integers such as `1`, `2`, and `3`. Children use the parent id plus a letter, such as `1a` and `2c`.

Ids never change when tasks are reordered or removed. Gaps are normal. Always copy the exact id from the current board or latest Task result. Do not infer an id from row position.

## Status state machine

`todo` -> `doing` -> `done`. From any state you can `canceled`.

- `start` (or `status: "doing"`) on a `todo` or `done` task.
- `done` (or `status: "done"`) on a `doing` task.
- `status: "canceled"` from any state, with optional `reason`.

## `canceled` is "abandoned", not "done"

`canceled` means the work was given up on. `done` means the work finished. The renderer paints them oppositely (lime ✔ vs red ✘), so picking the wrong verb reads as the opposite of intent.

- **Phase / section headers.** If you add `"PHASE 1: Setup"` and its subtasks finish, the header is `done`, not `canceled`. The phase IS done.
- **Parents with all-done children.** Last open child auto-promotes the parent. Do not also `done` the parent (hard error). A canceled sibling blocks auto-promote.
- Prefer real parent/subtask trees (`tasks` + `children`) over flat pseudo-headers.

## Don't

- Don't stringify arrays. Pass real `tasks` / `titles` arrays. On validation failure, retry **once** - never drip-`add` duplicates.
- Don't invent ids. Copy the canonical id from the board or latest tool result.
- Don't echo the task list as prose.
- Don't `remove` to "clean up" finished work - use `canceled` only when abandoning.
- Don't reach for `canceled` when you mean `done`.
- Don't demote a started task back to `todo` just because you started another.
- Don't `done` a parent after (or with) its last child - hard error if already done.
- Don't nest deeper than depth 2.
