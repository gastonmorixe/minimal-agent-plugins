/** Scenario table for the request golden harness. */

import { writeFileSync } from "node:fs"
import { join } from "node:path"

import type { Scenario } from "./harness.ts"
import { EXTRA_SCENARIOS } from "./scenarios-extra.ts"
import { GAP_SCENARIOS } from "./scenarios-gaps.ts"

const bash = (command: string) => ({ name: "Bash", input: { command } })

export const SCENARIOS: Scenario[] = [
  {
    name: "plain-turn",
    script: [{ text: "hello there" }],
    run: async ({ turn }) => turn("say hello"),
  },
  {
    name: "bash-ok",
    script: [{ tools: [bash("printf 'one\\ntwo\\n'")] }],
    run: async ({ turn }) => turn("run a command"),
  },
  {
    name: "bash-error",
    script: [{ tools: [bash("echo oops >&2; exit 3")] }],
    run: async ({ turn }) => turn("run a failing command"),
  },
  {
    name: "read-truncated",
    script: [{ tools: [{ name: "Read", input: { file_path: "big.txt" } }] }],
    setup: (cwd) => {
      const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`)
      writeFileSync(join(cwd, "big.txt"), `${lines.join("\n")}\n`)
    },
    run: async ({ turn }) => turn("read the big file"),
  },
  {
    // M3c 4c case A: only the per-line clamp cuts text; all lines are shown.
    name: "read-truncated-long-lines",
    script: [{ tools: [{ name: "Read", input: { file_path: "long-lines.txt" } }] }],
    setup: (cwd) => {
      const lines = Array.from({ length: 40 }, (_, i) =>
        i === 5 || i === 17 || i === 30 ? "W".repeat(20_000) : `short line ${i + 1}`,
      )
      // No trailing newline: the shown-line count then equals the file lines.
      writeFileSync(join(cwd, "long-lines.txt"), lines.join("\n"))
    },
    run: async ({ turn }) => turn("read the file with long lines"),
  },
  {
    // M3c 4c case B: the byte cut is inside line 8 (20 lines of 8000 chars).
    name: "read-truncated-partial-line",
    script: [{ tools: [{ name: "Read", input: { file_path: "partial.txt" } }] }],
    setup: (cwd) => {
      const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}:`.padEnd(8000, "x"))
      writeFileSync(join(cwd, "partial.txt"), lines.join("\n"))
    },
    run: async ({ turn }) => turn("read the file with wide lines"),
  },
  {
    name: "blob-spill",
    blobStore: true,
    script: [{ tools: [bash("seq 1 30000")] }],
    run: async ({ turn }) => turn("print many numbers"),
  },
  {
    name: "ask-mode-refusal",
    script: [{ tools: [bash("echo no")] }],
    run: async ({ turn, modes }) => {
      modes.setMode("ask")
      await turn("run a command in ask mode")
    },
  },
  {
    name: "mode-change",
    script: [{ text: "first" }, { text: "second" }],
    run: async ({ turn, modes }) => {
      await turn("turn one")
      modes.setMode("ask")
      await turn("turn two")
    },
  },
  {
    name: "abort-mid-tool",
    script: [{ tools: [bash("sleep 30")] }, { text: "after abort" }],
    run: async ({ turn, core }) => {
      const ac = new AbortController()
      setTimeout(() => ac.abort(), 500)
      await turn("run a long command", { signal: ac.signal }).catch((e: unknown) => {
        if ((e as { name?: string }).name !== "AbortError") throw e
      })
      core.notePreviousTurnAborted()
      await turn("continue please")
    },
  },
  {
    name: "max-tokens-continue",
    script: [{ text: "partial answer", stopReason: "max_tokens" }, { text: "rest" }],
    run: async ({ turn }) => turn("write a long answer"),
  },
  {
    name: "round-50-reflection-checkpoint",
    script: Array.from({ length: 52 }, () => ({ tools: [bash("true")] })),
    keep: [0, 49, 50, 51],
    run: async ({ turn }) => turn("do many rounds"),
  },
  ...EXTRA_SCENARIOS,
  ...GAP_SCENARIOS,
]
