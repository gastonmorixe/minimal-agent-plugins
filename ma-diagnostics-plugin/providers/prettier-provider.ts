/**
 * Prettier provider (format), spawn-per-call.
 *
 * Mirrors {@link ./biome-provider.ts | BiomeProvider} structurally: run the
 * tool, adapt output to findings, and when the file differs from the project's
 * formatting re-run the formatter over the proposed text via stdin and embed
 * the CONCRETE line diff in the finding's message. Prettier is detected with
 * `--check`, whose non-zero exit means "not formatted" but is unreliable
 * across versions, so BOTH signals count: non-zero exit OR `[warn]` lines.
 * Expected content comes from `--stdin-filepath`, which honors the project's
 * .prettierrc / prettier.config.*.
 *
 * As with biome we never prescribe a command; the message shows what prettier
 * expects and defers to "the project's formatting setup".
 *
 * @module plugins/diagnostics/providers/prettier-provider
 */
import { relative } from "node:path"

import { adaptPrettier } from "../adapters/prettier.ts"
import { formatDiff } from "../lib/format-diff.ts"
import type { DiagnosticProvider } from "../lib/provider.ts"
import type { Finding } from "../lib/types.ts"

import { runCapture, type SpawnResult } from "./spawn.ts"

const EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|css)$/

/** Max diff lines embedded in one finding message before truncation. */
const MAX_DIFF_LINES = 20

/**
 * Diagnostic provider that shells out to the workspace's prettier binary for
 * one file and adapts the output to findings. Only handles paths inside the
 * workspace root with extensions prettier formats here.
 */
export class PrettierProvider implements DiagnosticProvider {
  readonly id = "prettier"
  readonly kind = "format" as const

  constructor(
    private readonly bin: string,
    private readonly root: string,
    private readonly runFn: typeof runCapture = runCapture,
  ) {}

  handles(path: string): boolean {
    return EXT_RE.test(path)
  }

  async check(path: string, text: string, signal?: AbortSignal): Promise<Finding[]> {
    // path.relative (not startsWith+slice): `/repo-other` must not match
    // root `/repo` and yield a garbage suffix.
    const relPath = relative(this.root, path)
    const rel = relPath.startsWith("..") ? path : relPath
    const res = await this.runFn(this.bin, ["--check", rel], {
      cwd: this.root,
      ...(signal ? { signal } : {}),
    })
    // Prettier 3.x prints `[warn]` lines on STDERR; older versions used
    // stdout. Scan both so either layout parses.
    const findings = adaptPrettier(`${res.stdout}\n${res.stderr}`)
    await this.embedFormatDiff(rel, text, findings, signal)
    return findings
  }

  /**
   * Replace the generic `format` message with the actual expected-content
   * diff, attributed to prettier. Best-effort: any failure leaves the generic
   * message in place.
   */
  private async embedFormatDiff(
    relPath: string,
    text: string,
    findings: Finding[],
    signal?: AbortSignal,
  ): Promise<void> {
    const idx = findings.findIndex((f) => f.code === "format")
    if (idx < 0 || !text) return
    try {
      const fmt = await this.runFn(this.bin, [`--stdin-filepath=${relPath}`], {
        cwd: this.root,
        input: text,
        ...(signal ? { signal } : {}),
      })
      if (fmt.code !== 0) return
      const d = formatDiff(text, fmt.stdout)
      if (!d) return
      let lines = d.lines
      let truncated = false
      if (lines.length > MAX_DIFF_LINES) {
        lines = lines.slice(0, MAX_DIFF_LINES)
        truncated = true
      }
      const head =
        `File does not match the project's formatting rules (reported by prettier). ` +
        `Expected content at line ${d.startLine} (diff, - current / + expected):\n` +
        `${lines.join("\n")}${truncated ? "\n…(truncated)" : ""}\n` +
        `Format the file according to the project's formatting setup.`
      findings[idx] = { ...findings[idx], message: head }
    } catch {
      /* keep the generic message */
    }
  }

  dispose(): void {
    /* stateless */
  }
}

export type { SpawnResult }
