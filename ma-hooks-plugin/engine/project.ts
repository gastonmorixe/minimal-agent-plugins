/**
 * Project root: the git root of the cwd, falling back to the cwd (SPEC.md
 * "Source discovery"). A `.git` dir or file (worktree, submodule) marks the
 * root. No `git` process is spawned.
 *
 * @module engine/project
 */

import { existsSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

import type { SourceRef } from "./types.ts"

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

/**
 * The absolute path with symlinks resolved. A missing tail keeps its names,
 * so two paths to a file that does not exist yet still compare equal.
 */
export function canonicalPath(p: string): string {
  const abs = resolve(p)
  try {
    return realpathSync(abs)
  } catch {
    const up = dirname(abs)
    return up === abs ? abs : join(canonicalPath(up), basename(abs))
  }
}

/**
 * Drop each project source that is the same file as a user source. When the
 * project root is the home dir, the project path can be the user file. That
 * copy would load twice and show as an untrusted project hook.
 */
export function withoutUserCopies(sources: SourceRef[]): SourceRef[] {
  const user = new Set(sources.filter((s) => s.scope === "user").map((s) => canonicalPath(s.path)))
  return sources.filter((s) => s.scope !== "project" || !user.has(canonicalPath(s.path)))
}
