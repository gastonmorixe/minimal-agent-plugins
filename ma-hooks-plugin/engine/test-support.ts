/**
 * Test support: a temp HOME and project with real shell-script fixtures.
 * Imported by tests only.
 *
 * @module engine/test-support
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

/** A temp HOME plus a temp git project. */
export interface Sandbox {
  root: string
  home: string
  agentHome: string
  project: string
  /** Env for the engine: temp HOME, no MINIMAL_AGENT_HOME override. */
  env: Record<string, string | undefined>
  /** Write a file (creates dirs). Returns its path. */
  write(rel: string, text: string): string
  /** Write an executable shell script under `<root>/bin`. Returns its path. */
  script(name: string, body: string): string
  cleanup(): void
}

/** Create a sandbox. The project has a `.git` dir so it is its own root. */
export function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "ma-hooks-"))
  const home = join(root, "home")
  const project = join(root, "project")
  mkdirSync(join(home, ".minimal-agent"), { recursive: true })
  mkdirSync(join(project, ".git"), { recursive: true })
  mkdirSync(join(root, "bin"), { recursive: true })
  const write = (rel: string, text: string): string => {
    const p = rel.startsWith("/") ? rel : join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
    return p
  }
  return {
    root,
    home,
    agentHome: join(home, ".minimal-agent"),
    project,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      // Same two vars as minimal-agent-cli/src/test-utils/temp-home-env.ts:27-35,
      // for any bun child a hook script may start.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
      MINIMAL_AGENT_NO_PLUGIN_SYNC: "1",
    },
    write,
    script(name, body) {
      const p = write(join("bin", name), `#!/bin/sh\n${body}\n`)
      chmodSync(p, 0o755)
      return p
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Build native config text for one channel and a list of command strings. */
export function nativeConfig(
  channel: string,
  commands: Array<string | Record<string, unknown>>,
  extra: Record<string, unknown> = {},
  matcher?: string,
): string {
  const hooks = commands.map((c) => (typeof c === "string" ? { type: "command", command: c } : c))
  return JSON.stringify({
    hooks: { [channel]: [{ ...(matcher ? { matcher } : {}), hooks }] },
    ...extra,
  })
}
