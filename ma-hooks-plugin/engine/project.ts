/**
 * Project root: the git root of the cwd, falling back to the cwd (SPEC.md
 * "Source discovery"). A `.git` dir or file (worktree, submodule) marks the
 * root. No `git` process is spawned.
 *
 * @module engine/project
 */

import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/** Find the git root above `cwd`, or return `cwd`. */
export function findProjectRoot(cwd: string): string {
  const start = resolve(cwd)
  let dir = start
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir
    const up = dirname(dir)
    if (up === dir) return start
    dir = up
  }
}
