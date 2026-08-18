/**
 * Resolve `x-cursor-client-version` for Cursor Connect calls.
 *
 * The agent gateway is picky: unknown / IDE-spike versions can surface as
 * Connect `resource_exhausted`. Prefer the installed Cursor Agent CLI stamp
 * (`cli-YYYY.MM.DD-<sha>`), then the baked default. Matching this stamp is
 * **not** enough if IDE checksum headers are also sent — see
 * `docs/agent-run-too-many-computers-postmortem.md`.
 *
 * @module llm/providers/cursor/client-version
 */

import { readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { CURSOR_CLIENT_VERSION_DEFAULT } from "./wire-constants.ts"

const VERSION_DIR_RE = /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/i

/** Newest `cli-*` stamp under `~/.local/share/cursor-agent/versions`, if any. */
export function detectInstalledCursorAgentVersion(home = homedir()): string | undefined {
  const dir = join(home, ".local/share/cursor-agent/versions")
  try {
    const names = readdirSync(dir).filter((name) => VERSION_DIR_RE.test(name))
    if (names.length === 0) return undefined
    names.sort()
    const newest = names.at(-1)
    return newest ? `cli-${newest}` : undefined
  } catch {
    return undefined
  }
}

/**
 * Client version advertised on Connect calls.
 * Override: `MA_CURSOR_CLIENT_VERSION`. Never reads auth secrets.
 */
export function resolveCursorClientVersion(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const fromEnv = env.MA_CURSOR_CLIENT_VERSION?.trim()
  if (fromEnv) return fromEnv
  return detectInstalledCursorAgentVersion(home) ?? CURSOR_CLIENT_VERSION_DEFAULT
}
