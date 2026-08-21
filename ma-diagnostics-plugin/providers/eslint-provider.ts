/**
 * ESLint provider (lint pass), spawn-per-call via `eslint <file> --format json`.
 *
 * Flat-config era: the project's own `eslint.config.*` drives rule selection,
 * so we just point eslint at one file and parse its JSON reporter output.
 * Exit codes per the v10 contract: 0 clean, 1 lint problems found (still
 * success for us, findings live on stdout), 2 fatal/config error (throw so
 * the runner degrades the provider rather than silently reporting nothing).
 *
 * Messages are passed through VERBATIM from eslint. No command suggestions
 * ("run eslint --fix" and friends are forbidden): attribution comes from the
 * finding's `source: "eslint"` prefix.
 *
 * @module plugins/diagnostics/providers/eslint-provider
 */
import { relative } from "node:path"

import { adaptEslint } from "../adapters/eslint.ts"
import type { DiagnosticProvider } from "../lib/provider.ts"
import type { Finding } from "../lib/types.ts"

import { runCapture, type SpawnResult } from "./spawn.ts"

const EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/**
 * Diagnostic provider that shells out to the workspace's eslint binary for
 * one file and adapts the `--format json` output to findings. Only handles
 * paths inside the workspace root with JS/TS extensions.
 */
export class EslintProvider implements DiagnosticProvider {
  readonly id = "eslint"
  readonly kind = "lint" as const

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
    const res: SpawnResult = await this.runFn(this.bin, [rel, "--format", "json"], {
      cwd: this.root,
      ...(signal ? { signal } : {}),
    })
    // Exit 2 = fatal / config error (not lint findings). Throw so the runner
    // records a degraded outcome instead of a silent empty pass.
    if (res.code === 2) {
      throw new Error(`eslint failed (exit 2): ${res.stderr.trim() || "fatal config error"}`)
    }
    return adaptEslint(res.stdout)
  }

  dispose(): void {
    /* stateless */
  }
}
