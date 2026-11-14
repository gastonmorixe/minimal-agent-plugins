/**
 * Test fixture: run the real `ChromeCDP` handler path twice with the default
 * lease writer (env `CDP_SOCK` and `CDP_LEASE_DIR` point at a test dir), then
 * exit normally. The daemon is never reached: `ensure` answers false. Prints
 * the lease body after each call, one per line, so the parent can check the
 * refresh. The parent then checks that the lease file is gone after the exit.
 *
 * @module handlers/chrome_cdp.lease.fixture
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { TUIContext } from "../lib/types.ts"

import { runWithDeps } from "./chrome_cdp.ts"

const ctx: TUIContext = {
  trigger: { type: "tool", name: "ChromeCDP", input: { action: "targets" } },
  packageDir: "/pkg",
  cwd: "/cwd",
  env: {},
  abort: new AbortController().signal,
  stdout: process.stdout,
  stdin: process.stdin,
  stderr: process.stderr,
}

const lease = join(process.env.CDP_LEASE_DIR ?? "", String(process.pid))
const lines: string[] = []
for (let i = 0; i < 2; i++) {
  await runWithDeps(ctx, { ensure: async () => false, spawnDaemon: () => {} })
  lines.push(readFileSync(lease, "utf8").trim())
  await new Promise((r) => setTimeout(r, 20))
}
process.stdout.write(`${lines.join("\n")}\n`)
