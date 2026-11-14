/**
 * Gap scenarios for the request golden harness (S11.2g): sites that the older
 * tables do not pin. Each one uses a fixture plugin under fixtures/.
 */

import { join } from "node:path"

import type { Scenario } from "./harness.ts"

const FIXTURES = join(import.meta.dir, "fixtures")
const bash = (command: string) => ({ name: "Bash", input: { command } })

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
]
