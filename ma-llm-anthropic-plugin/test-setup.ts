/**
 * Test preload (bunfig.toml `[test].preload`): point `MINIMAL_AGENT_HOME` at
 * a fresh temp dir for the whole run, so no test can write the real
 * `~/.minimal-agent` (e.g. `state/anthropic/device.json`, written by
 * identity.ts `getOwnDeviceId`). Removed on exit.
 *
 * @module llm/providers/anthropic/test-setup
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "ma-anthropic-test-home-"))
process.env.MINIMAL_AGENT_HOME = home
process.on("exit", () => {
  rmSync(home, { recursive: true, force: true })
})
