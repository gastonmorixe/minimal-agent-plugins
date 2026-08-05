# Tasks

Use `Task` to plan and track multi-step work the user can watch in real time. The live list is auto-injected into every user turn as a `<ma::agent::tasks ...>` block, so you always see the current plan without re-querying.

## When to use

- **Use it** when you're about to do something with **3+ distinct steps** the user will want to track. Most refactors, multi-file changes, bug investigations with branching hypotheses, anything where "the plan" is a meaningful artifact.
- **Use it** when the user says "make a plan", "what would you do", "let's tackle X", or otherwise signals they want to see the shape of the work before you start.
- **A single task with 3+ substeps** worth tracking: use `parent` to nest. Tree depth is limited to 2 (top-level + one layer of children). Don't try to nest deeper.

## When not to use

- Trivial 1-2 step tasks. Just do them.
- Recording past decisions or lessons-learned. That's `memory`.
- Tracking transient agent-internal state ("remember to re-grep after this edit"). Use `short-term` memory.
- Free-form notes for the user. Put those in your prose response.

## Workflow

1. **Plan in one shot.** `Task({action: "add_many", titles: [...]})` at the start, or `items: [{title, children?}]` when you need new top-level phases with subtasks in the same call (`titles` XOR `items`; children are `string[]` only). `items` cannot attach to an existing parent; use flat `titles` with a top-level `parent` instead. Don't drip-feed tasks one at a time. The user wants to see the whole plan up front. A top-level `add_many` automatically replaces a fully terminal board (all rows `done` or `canceled`), so a new plan starts again at visible position `1`; it still appends while any prior row is `todo` or `doing`.
2. **Start before you work.** `Task({action: "start", id: N})` flips the task to `doing` and leaves every previously started task as `doing`. Starting a subtask also auto-starts its parent. Started work stays started until you mark it `done`, `canceled`, or explicitly set it back to `todo`. Multiple tasks and subtasks can be `doing` at once.
3. **Done when materially complete.** `Task({action: "done", id: N})`. Don't pre-mark. Only mark `done` when you've actually finished the work the title described. Completing a child while siblings remain open keeps its parent `doing`; the last open child auto-promotes its parent to `done` (and may return `all_done` for the whole plan). Parent `done` cascades open children. **Never also `done` the parent in the same turn as the last child** - cascade already finished it; a second call is a no-op that returns compact `already_done` (no full board).
4. **New substeps surface as you work.** If you discover a task is actually 3 substeps, `Task({action: "add", title: "...", parent: "#<hash>"})` for each. Then `start` the first child.
5. **Plans change.** If the user redirects, don't silently abandon tasks:
   - If a task was never started, `remove` it.
   - If a task is still in-flight or was completed but reverted,
     `status: "canceled"` with a one-line `reason`.

## Id resolution

Every action that takes an `id` accepts these forms:

- **Position** (1-indexed integer). `id: 3` means the third top-level task in the list. Most natural in conversational use.
- **Bare hash**: `id: "a7b3c4"`. Six lowercase hex chars.
- **Prefixed hash**: `id: "#a7b3c4"`. Same as bare. The `#` is purely cosmetic.
- **Subtask hash**: `id: "a7b3c4a"`. Parent's hash + a-z suffix.
- **Subtask display coordinate**: `id: "3a"`. This matches the visible child-row label under top-level task 3. Do **not** prefix it with `#`: `#` denotes a stable hash.

The hash is stable across reorders and deletes. Display positions and coordinates shift. So when reordering or doing bulk operations, lean on the hash. For single "mark the next one done" interactions, the visible position or coordinate is fine.

## Status state machine

```
             add
              │
              ▼
   ┌────┐   start    ┌─────┐  complete   ┌────┐
   │todo│ ─────────► │doing│ ──────────► │done│
   └──┬─┘            └──┬──┘             └────┘
      └──── cancel ◄────┘
```

- `start` (or `status: "doing"`) on a `todo` or `done` task.
- `done` (or `status: "done"`) on a `doing` task.
- `status: "canceled"` from any state, with optional `reason`.
- `status: "todo"` to reset (rare, usually `start` again instead).

## `canceled` is "abandoned", not "done"

`canceled` means the work was given up on. `done` means the work finished. The two are not interchangeable, and the renderer paints them in opposite colors (lime ✔ for done, red ✘ with strikethrough for canceled), so picking the wrong verb reads as the opposite of intent.

Common confusions:

- **Phase / section headers.** If you add a top-level task like `"PHASE 1: Setup"` and the work under it finishes, the header is `done`, not `canceled`. The phase IS done. Reasoning like "the header itself had no direct work, so it was never going to be done" is wrong. A header means the work under it, and that work happened.
- **Parents with all-done children.** Same idea. Marking the last open child `done` auto-promotes the parent; marking a parent `done` cascades open children. You do not need a second call - and must not issue one in parallel with the last child. A canceled sibling blocks auto-promote. Re-`done` on an already-done id returns compact `already_done` (not another full table / "all done" frame).
- **Tasks made moot by a sibling.** If task B made task A's goal unnecessary because the goal already got achieved (just elsewhere), A is `done`. If A's goal was actively rejected, A is `canceled` with a one-line `reason`.

For multi-phase plans, real parent/subtask structure is cleaner than flat pseudo-headers. Phase becomes the parent, and the work under it becomes subtasks:

```
Task({
  action: "add_many",
  items: [{ title: "Phase 1: Setup", children: ["step a", "step b"] }]
})
// ...do the work...
Task({action: "done", id: "#<phase>a"})
Task({action: "done", id: "#<phase>b"})  // parent auto-promotes; do not also done the parent
```

A flat list with "PHASE 1" pseudo-headers at the top level also works, but each header is then a real task and needs a real `done` (or `canceled` with a reason) when the phase ends.

## Examples

Start a new plan:

```
Task({
  action: "add_many",
  titles: [
    "Add contextSize to SessionTokens",
    "Update addSessionUsage callers",
    "Update clearSessionTokens to reset contextSize",
    "Update src/session-tokens.test.ts",
    "Run biome format + lint on touched files"
  ]
})
```

With subtasks in the same call:

```
Task({
  action: "add_many",
  items: [
    { title: "Phase 1: Setup", children: ["step a", "step b"] },
    { title: "Phase 2: Ship" }
  ]
})
```

Work through it:

```
Task({action: "start", id: 1})
   ...do the work, then...
Task({action: "done", id: 1})
Task({action: "start", id: 2})
   ...
```

Discover substeps mid-task:

```
Task({action: "add", title: "Zero-state includes contextSize", parent: "#d04c91"})
Task({action: "add", title: "Multi-turn growth pinned", parent: "#d04c91"})
Task({action: "start", id: "#d04c91a"})   # subtask hash = parent + 'a'
```

Cancel a step the user redirected away from:

```
Task({action: "status", id: 6, status: "canceled", reason: "user wants to keep the legacy column"})
```

## Don't

- Don't echo the rendered task list back to the user as prose. They see the rich rendering in the transcript already. Restating in markdown is noise.
- Don't `remove` a task as a way of "cleaning up". That erases the audit trail. Use `status: "canceled"` for anything that materially existed but was later abandoned. Only `remove` tasks you accidentally added or that the user explicitly asks to drop.
- Don't reach for `canceled` when you mean `done`. If a phase header, parent task, or planning placeholder has no direct work of its own but the work under it finished, it is `done` (auto-promoted when the last child finishes). See "`canceled` is 'abandoned', not 'done'" above.
- Don't demote a started task back to `todo` just because you started another one. `start` already accumulates. Only leave `doing` via `done`, `canceled`, or an intentional `status: "todo"`.
- Don't `done` a parent after (or in parallel with) finishing its last open child. Auto-promote already marked the parent. A redundant `done` returns `already_done` without a full board - still wasted tool call and UI noise. One `done` on the last child is enough.
- Don't try to nest beyond depth 2 (subtask of a subtask). `Task` refuses it. Flatten the deepest layer into the parent's title or split into a sibling top-level task.
