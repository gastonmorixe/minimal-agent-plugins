/**
 * tsc-direct provider — out-of-scope type fallback.
 *
 * When the normal tsgo/tsc providers return nothing (file outside tsconfig
 * `include`), this provider type-checks a single file and tags every finding
 * `scope: "ad-hoc"`.
 *
 * IMPORTANT: do **not** use `tsc --ignoreConfig`. That drops `jsx`, `paths`,
 * and every other project option, so in-project React/alias code produces a
 * wall of false TS17004 / TS6142 / TS2307. Instead:
 *
 *  1. If a `tsconfig.json` is found (walk up from the file, else project root),
 *     write a tiny temp config that `extends` it and `include`s only this file,
 *     then run `tsc --noEmit -p <temp>`.
 *  2. Otherwise run `tsc` on the file with modern defaults that include
 *     `--jsx react-jsx` (so `.tsx` still type-checks).
 *
 * Stateless spawn-per-check; cleans up the temp config afterward.
 *
 * @module plugins/diagnostics/providers/tsc-direct-provider
 */
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import { adaptTscOutput } from "../adapters/tsc.ts"
import type { DiagnosticProvider } from "../lib/provider.ts"
import type { Finding } from "../lib/types.ts"

import { runCapture } from "./spawn.ts"

const EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/** Walk parents from `startDir` up to (and including) `root` for tsconfig.json. */
function findTsconfigUp(startDir: string, root: string): string | null {
  const rootAbs = resolve(root)
  let dir = resolve(startDir)
  for (;;) {
    const candidate = join(dir, "tsconfig.json")
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        /* ignore */
      }
    }
    if (dir === rootAbs) break
    const parent = dirname(dir)
    if (parent === dir) break
    if (relative(rootAbs, parent).startsWith("..")) break
    dir = parent
  }
  const rootConfig = join(rootAbs, "tsconfig.json")
  return existsSync(rootConfig) ? rootConfig : null
}

/**
 * Runs a single-file typecheck that preserves project options when a tsconfig
 * exists (extends + include-only-this-file), instead of `--ignoreConfig`.
 */
export class TscDirectProvider implements DiagnosticProvider {
  readonly id = "tsc-direct"
  readonly kind = "type" as const

  constructor(
    private readonly bin: string,
    private readonly root: string,
  ) {}

  handles(path: string): boolean {
    return EXT_RE.test(path)
  }

  async check(path: string, _text: string, signal?: AbortSignal): Promise<Finding[]> {
    const abs = isAbsolute(path) ? path : resolve(this.root, path)
    let tempDir: string | null = null
    try {
      const tsconfig = findTsconfigUp(dirname(abs), this.root)
      let args: string[]
      if (tsconfig) {
        tempDir = mkdtempSync(join(tmpdir(), "ma-tsc-direct-"))
        // Use an absolute extends path so cwd does not matter.
        // `include` overrides the base config's include — only this file is checked.
        const tempConfig = join(tempDir, "tsconfig.json")
        writeFileSync(
          tempConfig,
          JSON.stringify(
            {
              extends: tsconfig,
              include: [abs],
              // Clear base exclude that might accidentally drop the file.
              exclude: [],
              compilerOptions: {
                // Guarantees even if a weird base omitted these (should not).
                noEmit: true,
              },
            },
            null,
            2,
          ),
        )
        args = ["--noEmit", "--pretty", "false", "-p", tempConfig]
      } else {
        // No project config: sensible modern defaults, including JSX for .tsx.
        args = [
          "--noEmit",
          "--pretty",
          "false",
          "--strict",
          "--jsx",
          "react-jsx",
          "--module",
          "ESNext",
          "--moduleResolution",
          "bundler",
          "--target",
          "ES2022",
          "--esModuleInterop",
          "--skipLibCheck",
          abs,
        ]
      }

      const result = await runCapture(this.bin, args, {
        cwd: this.root,
        signal,
      })
      const findings = adaptTscOutput(result.stdout, this.id, abs)
      for (const f of findings) f.scope = "ad-hoc"
      return findings
    } catch {
      return []
    } finally {
      if (tempDir) {
        try {
          rmSync(tempDir, { recursive: true, force: true })
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  }

  dispose(): void {}

  isActive(): boolean {
    return false
  }
}
