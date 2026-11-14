/**
 * Host fixture for `tool-registry.exit.test.ts` (fix-3i).
 *
 * Usage: `bun tool-registry.exit-fixture.ts <skillDir>`. It invokes the
 * `scripts/forks` skill script, waits until the script wrote its pid file
 * (`<skillDir>/pids`, so the script is still running), then calls
 * `process.exit(0)` with the script in flight. The test then checks that the
 * script and its background child are gone.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { toolSpecToHandler } from "./tool-registry.ts"
import type { ToolSpec } from "./types.ts"

const dir = process.argv[2]
if (!dir) {
  console.error("usage: tool-registry.exit-fixture.ts <skillDir>")
  process.exit(2)
}

const spec = {
  name: "Forks",
  description: "fork a background sleep",
  parameters: { type: "object", properties: {} },
  handler: { type: "script", path: "scripts/forks", argTemplate: "x", timeoutMs: 60_000 },
} as unknown as ToolSpec
const h = toolSpecToHandler(spec, dir, { env: { PATH: process.env.PATH } }) as {
  invoke: (ctx: Record<string, unknown>) => Promise<Record<string, unknown>>
}
void h.invoke({ trigger: { type: "tool", input: {} } })

const file = join(dir, "pids")
const end = Date.now() + 5000
while (Date.now() < end) {
  if (existsSync(file) && readFileSync(file, "utf8").trim().split(/\s+/).length === 2) {
    process.exit(0)
  }
  await Bun.sleep(20)
}
console.error("script did not write its pids")
process.exit(3)
