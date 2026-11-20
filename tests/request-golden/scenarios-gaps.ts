/**
 * Gap scenarios for the request golden harness (S11.2g): sites that the older
 * tables do not pin. Each one uses a fixture plugin under fixtures/.
 */

import { writeFileSync } from "node:fs"
import { join } from "node:path"

import type { Scenario } from "./harness.ts"

const FIXTURES = join(import.meta.dir, "fixtures")
const bash = (command: string) => ({ name: "Bash", input: { command } })

/**
 * A wave: one model response with 2 concurrency-safe calls (Read, Read)
 * under concurrency cap 2. The next request must hold the tool_use blocks
 * and the tool_result blocks in call order. `wave.test.ts` also runs it
 * with cap 1 and expects the same bytes.
 */
export const WAVE_TWO_READS: Scenario = {
  name: "wave-two-reads",
  script: [
    {
      tools: [
        { name: "Read", input: { file_path: "a.txt" } },
        { name: "Read", input: { file_path: "b.txt" } },
      ],
    },
  ],
  setup: (cwd) => {
    writeFileSync(join(cwd, "a.txt"), "alpha\n")
    writeFileSync(join(cwd, "b.txt"), "bravo\n")
  },
  coreDeps: () => ({ maxConcurrentToolCalls: 2 }),
  run: async ({ turn }) => turn("read the two files"),
}

export const GAP_SCENARIOS: Scenario[] = [
  {
    // No tool executor: core's NO_TOOLS_EXECUTOR text returns as the tool_result.
    name: "no-executor",
    noExecutor: true,
    script: [{ tools: [{ name: "Stub", input: {} }] }],
    run: async ({ turn }) => turn("call the stub tool"),
  },
  {
    // Subprocess handler prints 6000000 bytes. Core caps stdout at 5 MiB.
    name: "subprocess-overflow",
    script: [{ tools: [{ name: "FixtureOverflow", input: {} }] }],
    pluginRoots: () => [join(FIXTURES, "overflow")],
    run: async ({ turn }) => turn("call the overflowing fixture tool"),
    keep: [-1],
  },
  {
    // Plugin tool handler returns a rendered value, not a tool_result.
    name: "non-tool-result",
    script: [{ tools: [{ name: "FixtureNonResult", input: {} }] }],
    pluginRoots: () => [join(FIXTURES, "nonresult")],
    run: async ({ turn }) => turn("call the non-result fixture tool"),
    keep: [-1],
  },
  {
    // A fail-closed tool.willInvoke hook throws. The tool call is denied.
    name: "policy-hook-failed",
    script: [{ tools: [bash("echo hi")] }],
    pluginRoots: () => [join(FIXTURES, "hookfail")],
    run: async ({ turn }) => turn("run bash under a broken approval hook"),
    keep: [-1],
  },
  WAVE_TWO_READS,
  {
    // Worker only (sub-agents Design A): the budget stamp stage adds a
    // `<ma::agent::budget ... level="warn">` tag at the tool_result tail,
    // after the core mode-active stamp. The worker stream file says turn 2
    // started, and maxTurns 4 gives 2 turns left (warn at <= floor(4 / 2) = 2,
    // final only at 1 left), so `warn`. The start is in the future, so elapsed is 0 and
    // remaining is the full 1800 s (no clock in the golden). The harness
    // restores the env after the run.
    name: "subagent-budget-warn",
    script: [{ tools: [{ name: "Read", input: { file_path: "note.txt" } }] }],
    setup: (cwd) => {
      writeFileSync(`${cwd}/note.txt`, "hi\n")
      process.env.MINIMAL_AGENT_SUBAGENT_RESULT_PATH = `${cwd}/../worker-sid.result.json`
      // The own stream file (sid from the sentinel name): turn 2 started.
      writeFileSync(
        `${cwd}/../worker-sid.stream.ndjson`,
        `${JSON.stringify({ type: "turn_started", turn: 1 })}\n${JSON.stringify({ type: "turn_started", turn: 2 })}\n`,
      )
      process.env.MINIMAL_AGENT_SUBAGENT_BUDGET = JSON.stringify({ deadlineSec: 1800, maxTurns: 4 })
      process.env.MINIMAL_AGENT_SUBAGENT_STARTED_AT = "2100-01-01T00:00:00.000Z"
    },
    run: async ({ turn, modes }) => {
      modes.setMode("ask")
      await turn("read a file as a budgeted worker")
    },
    keep: [-1],
  },
]
