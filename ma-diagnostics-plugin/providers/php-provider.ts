/**
 * PHP syntax provider (type pass), spawn-per-call via `php -l <file>`.
 *
 * Uses the project's PATH `php` binary. Exit 0 means clean. Non-zero means a
 * syntax error: findings come from stdout+stderr via {@link adaptPhp}. When the
 * process exits non-zero but the adapter finds nothing usable, emit one generic
 * syntax finding so the runner still surfaces a problem.
 *
 * Messages are passed through from php. No command suggestions
 * ("run php -l" and friends are forbidden): attribution comes from the
 * finding's `source: "php"` prefix.
 *
 * @module plugins/diagnostics/providers/php-provider
 */
import { relative } from "node:path"

import { adaptPhp } from "../adapters/php.ts"
import type { DiagnosticProvider } from "../lib/provider.ts"
import type { Finding } from "../lib/types.ts"

import { runCapture, type SpawnResult } from "./spawn.ts"

const EXT_RE = /\.php$/i

/** Generic finding when php exits non-zero but stdout/stderr did not parse. */
const GENERIC_SYNTAX_MESSAGE = "PHP reported a syntax error while checking this file."

/**
 * Diagnostic provider that shells out to the workspace's php binary for one
 * file (`php -l`) and adapts the output to findings. Only handles paths with a
 * `.php` extension.
 */
export class PhpProvider implements DiagnosticProvider {
  readonly id = "php"
  readonly kind = "type" as const

  constructor(
    private readonly bin: string,
    private readonly root: string,
    private readonly runFn: typeof runCapture = runCapture,
  ) {}

  handles(path: string): boolean {
    return EXT_RE.test(path)
  }

  async check(path: string, _text: string, signal?: AbortSignal): Promise<Finding[]> {
    // path.relative (not startsWith+slice): `/repo-other` must not match
    // root `/repo` and yield a garbage suffix.
    const relPath = relative(this.root, path)
    const rel = relPath.startsWith("..") ? path : relPath
    const res: SpawnResult = await this.runFn(this.bin, ["-l", rel], {
      cwd: this.root,
      ...(signal ? { signal } : {}),
    })
    const findings = adaptPhp(`${res.stdout}\n${res.stderr}`)
    if (findings.length > 0) return findings
    if (res.code !== 0 && res.code !== null) {
      return [
        {
          source: "php",
          severity: "error",
          code: "syntax",
          path: rel,
          message: GENERIC_SYNTAX_MESSAGE,
        },
      ]
    }
    return []
  }

  dispose(): void {
    /* stateless */
  }
}

export type { SpawnResult }
