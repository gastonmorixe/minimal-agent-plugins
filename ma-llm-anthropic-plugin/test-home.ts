/**
 * Test helper: point `MINIMAL_AGENT_HOME` at a fresh temp dir for one test
 * file, so the file is self-contained even when `bun test` runs from the
 * monorepo root (where this plugin's bunfig.toml preload, ./test-setup.ts,
 * does not apply). No test may write the real `~/.minimal-agent` (e.g.
 * `state/anthropic/device.json`, written by identity.ts `getOwnDeviceId`).
 *
 * @module llm/providers/anthropic/test-home
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll } from "bun:test"

import { _resetIdentityForTest } from "./identity.ts"
import { _resetWireOptionsForTest } from "./wire-options.ts"

/**
 * Register file-level hooks: before the file's tests, set
 * `MINIMAL_AGENT_HOME` to a new temp dir and drop the cached device-id and
 * config paths; after them, restore the previous value and remove the dir.
 * Call once at the top level of a test file.
 */
export function useTempAgentHome(): void {
  let home: string | undefined
  let saved: string | undefined
  beforeAll(() => {
    saved = process.env.MINIMAL_AGENT_HOME
    home = mkdtempSync(join(tmpdir(), "ma-anthropic-test-home-"))
    process.env.MINIMAL_AGENT_HOME = home
    _resetIdentityForTest()
    _resetWireOptionsForTest()
  })
  afterAll(() => {
    if (saved === undefined) delete process.env.MINIMAL_AGENT_HOME
    else process.env.MINIMAL_AGENT_HOME = saved
    _resetIdentityForTest()
    _resetWireOptionsForTest()
    if (home) rmSync(home, { recursive: true, force: true })
  })
}
