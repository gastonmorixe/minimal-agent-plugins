/**
 * Biome provider (format + assist + biome's own lint pass), spawn-per-call.
 *
 * Biome is fast (~60ms/file measured). We check the file ON DISK rather than
 * via `--stdin-file-path`: the `tool.didInvoke` hook fires AFTER the Edit/Write
 * has already written the file, so disk == the proposed text, and disk mode is
 * the one that emits clean `--reporter=json` on stdout (stdin mode instead
 * echoes the formatted source and routes status to stderr, which is unusable
 * here). `--reporter=json` feeds the {@link adaptBiome} adapter.
 *
 * Biome's JSON for a `format` finding carries NO content ("Formatter would
 * have printed the following content:", position 0:0), which forces the model
 * to guess. So when we see one we re-run the formatter over the text and embed
 * the CONCRETE line diff in the finding's message: the model sees exactly what
 * biome expects, attributed to biome, without us prescribing any command (the
 * project may wire its formatter differently).
 *
 * @module plugins/diagnostics/providers/biome-provider
 */
import { relative } from "node:path"

import { adaptBiome } from "../adapters/biome.ts"
import { formatDiff } from "../lib/format-diff.ts"
import type { DiagnosticProvider } from "../lib/provider.ts"
import type { Finding } from "../lib/types.ts"

import { runCapture } from "./spawn.ts"

const EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|css)$/

/** Max diff lines embedded in one finding message before truncation. */
const MAX_DIFF_LINES = 20

/**
 * Diagnostic provider that shells out to the workspace's biome binary
 * (`biome check --reporter=json`) for one file and adapts the output to
 * findings. Only handles paths inside the workspace root with extensions
 * biome formats/lints.
 */
export class BiomeProvider implements DiagnosticProvider {
  readonly id = "biome"
  readonly kind = "format" as const

  constructor(
    private readonly bin: string,
    private readonly root: string,
  ) {}

  handles(path: string): boolean {
    return EXT_RE.test(path)
  }

  async check(path: string, _text: string, signal?: AbortSignal): Promise<Finding[]> {
    // path.relative (not startsWith+slice): `/repo-other` must not match
    // root `/repo` and yield a garbage suffix.
    const relPath = relative(this.root, path)
    const rel = relPath.startsWith("..") ? path : relPath
    const res = await runCapture(this.bin, ["check", "--reporter=json", rel], {
      cwd: this.root,
      ...(signal ? { signal } : {}),
    })
    const findings = adaptBiome(res.stdout)
    await this.embedFormatDiff(rel, _text, findings, signal)
    return findings
  }

  /**
   * Replace the generic `format` message with the actual expected-content
   * diff, attributed to biome. Best-effort: any failure leaves the generic
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
      const fmt = await runCapture(this.bin, ["format", `--stdin-file-path=${relPath}`], {
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
        `File does not match the project's formatting rules (reported by biome). ` +
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
