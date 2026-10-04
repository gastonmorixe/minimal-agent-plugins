/**
 * Laravel Pint provider (format), spawn-per-call via
 * `pint --test --format=json -v -- <file>`.
 *
 * Always passes `--test` so the run never mutates files. `-v` asks for richer
 * reporter fields (fixers / proposed diff when the installed Pint provides them).
 * `--` ends option parsing so paths that start with `-` stay file args. JSON
 * output is adapted by {@link adaptPint}. When the adapter returns nothing but
 * the process exits 1 (style mismatch), emit one generic format finding for the
 * checked path.
 *
 * Messages never prescribe a pint or php command. Attribution comes from the
 * finding's `source: "pint"` prefix.
 *
 * @module plugins/diagnostics/providers/pint-provider
 */
import { relative } from "node:path"

import { adaptPint, PINT_GENERIC_MESSAGE } from "../adapters/pint.ts"
import type { DiagnosticProvider } from "../lib/provider.ts"
import type { Finding } from "../lib/types.ts"

import { runCapture, type SpawnResult } from "./spawn.ts"

const EXT_RE = /\.php$/i

/**
 * Diagnostic provider that shells out to the workspace's pint binary for one
 * file and adapts check-only JSON output to findings. Only handles `.php`
 * paths. Uses whatever Pint the project installed (no version pin).
 */
export class PintProvider implements DiagnosticProvider {
  readonly id = "pint"
  readonly kind = "format" as const

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
    const res: SpawnResult = await this.runFn(
      this.bin,
      ["--test", "--format=json", "-v", "--", rel],
      {
        cwd: this.root,
        ...(signal ? { signal } : {}),
      },
    )
    const combined = `${res.stdout}\n${res.stderr}`
    const findings = adaptPint(combined)
    if (findings.length > 0) return findings
    // Exit 1 = style mismatch (diagnostics, not runner failure).
    if (res.code === 1) {
      return [
        {
          source: "pint",
          severity: "warning",
          code: "format",
          path: rel,
          message: PINT_GENERIC_MESSAGE,
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
