#!/usr/bin/env bun
/**
 * Obscura backend for the Fetch tool.
 *
 * Two roles in one file:
 *
 *   1. **Executable** (when run as `bun backends/obscura.ts`):
 *      reads `MA_FETCH_*` env vars, builds argv, spawns obscura, and
 *      pipes stdout/stderr/exit-code through verbatim.
 *
 *   2. **Library** (when imported by tests or future tooling):
 *      exports the pure `buildArgv()` function so argv assembly is
 *      unit-testable without spawning a real obscura.
 *
 * The handler in `handlers/fetch.ts` only knows about the executable
 * role - it spawns this file as a subprocess and treats it as a black
 * box. Tomorrow's `backends/playwright.ts` just needs to honor the
 * same env-var contract and the handler stays unchanged.
 *
 * ## Env-var contract (subprocess input)
 *
 *   MA_FETCH_URL          (required)  URL to fetch
 *   MA_FETCH_FORMAT       (required)  one of: markdown|text|html|links|original
 *   MA_FETCH_WAIT_UNTIL   (required)  one of: load|domcontentloaded|networkidle0
 *   MA_FETCH_TIMEOUT_SEC  (required)  integer seconds
 *   MA_FETCH_SELECTOR     (optional)  CSS selector to wait for / scope output
 *   MA_FETCH_EVAL         (optional)  JS expression to evaluate
 *   MA_FETCH_USER_AGENT   (optional)  override UA (plugin-config provided)
 *   MA_FETCH_PROXY        (optional)  HTTP/SOCKS5 proxy URL (plugin-config provided)
 *   MA_FETCH_STORAGE_DIR  (optional)  absolute path; forwarded as
 *                                     `--storage-dir <DIR>` so obscura
 *                                     persists cookies + localStorage to
 *                                     this directory across runs. The
 *                                     handler is the sole party allowed
 *                                     to set this — already resolved and
 *                                     sandboxed under the plugin's
 *                                     `storageRoot`. Backend treats it
 *                                     verbatim, no further checks.
 *   MA_FETCH_BIN          (optional)  path to obscura binary (default: "obscura" on PATH)
 *   MA_FETCH_EXTENSIONS   (optional)  newline-separated list of WebExtension
 *                                     bundle paths (`.crx`, `.xpi`, `.zip`, or
 *                                     unpacked dir). Each entry becomes one
 *                                     `--extension <PATH>`. Obscura today
 *                                     honors only the first and warns on
 *                                     extras.
 *
 * ## Output contract
 *
 *   stdout  → page content (verbatim from obscura)
 *   stderr  → diagnostics (verbatim from obscura)
 *   exit    → obscura's exit code (0 = success)
 *
 * ## What's baked in (and why it's NOT exposed via env)
 *
 *   --stealth   Anti-bot hygiene. Always on. If we ever swap to a
 *               Playwright backend, stealth would still be on - just
 *               implemented differently. Not the model's concern.
 *
 *   --quiet     Suppress obscura's startup banner. Always on so our
 *               stdout is pure page content.
 *
 * @module backends/obscura
 */

export interface BuildArgvOptions {
  /** URL to fetch. Required. */
  url: string
  /** Output format. Required. */
  format: "markdown" | "text" | "html" | "links" | "original"
  /** Wait policy. Required. */
  waitUntil: "load" | "domcontentloaded" | "networkidle0"
  /** Navigation timeout in seconds. Required. */
  timeoutSec: number
  /** Optional CSS selector. */
  selector?: string
  /** Optional JS expression to evaluate. */
  evalExpr?: string
  /** Optional User-Agent override (from plugin config). */
  userAgent?: string
  /** Optional proxy URL (from plugin config). */
  proxy?: string
  /** Optional WebExtension bundle paths. Each becomes `--extension <PATH>`. */
  extensions?: string[]
  /** Optional absolute path forwarded as `--storage-dir <DIR>`. When set,
   *  obscura persists cookies + localStorage to this directory and loads
   *  them on the next run with the same path. */
  storageDir?: string
}

/**
 * Build the argv list passed to obscura. Pure - no I/O, no env.
 *
 * Invariants:
 *   - `--stealth` always present (anti-bot hygiene).
 *   - `--quiet` always present (clean stdout).
 *   - URL is the final positional argument.
 *   - Optional flags only appear when their corresponding option is set
 *     (no empty-string `--selector ""` artifacts).
 */
export function buildArgv(opts: BuildArgvOptions): string[] {
  const argv: string[] = [
    "fetch",
    "--dump",
    opts.format,
    "--wait-until",
    opts.waitUntil,
    "--timeout",
    String(opts.timeoutSec),
    "--stealth",
    "--quiet",
  ]
  if (opts.selector && opts.selector.length > 0) {
    argv.push("--selector", opts.selector)
  }
  if (opts.evalExpr && opts.evalExpr.length > 0) {
    argv.push("--eval", opts.evalExpr)
  }
  if (opts.userAgent && opts.userAgent.length > 0) {
    argv.push("--user-agent", opts.userAgent)
  }
  if (opts.proxy && opts.proxy.length > 0) {
    argv.push("--proxy", opts.proxy)
  }
  if (opts.extensions && opts.extensions.length > 0) {
    for (const e of opts.extensions) {
      argv.push("--extension", e)
    }
  }
  if (opts.storageDir && opts.storageDir.length > 0) {
    argv.push("--storage-dir", opts.storageDir)
  }
  argv.push(opts.url)
  return argv
}

// ---------------------------------------------------------------------------
// Env parsing (subprocess role)
// ---------------------------------------------------------------------------

export class BackendInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BackendInputError"
  }
}

const VALID_FORMATS = new Set(["markdown", "text", "html", "links", "original"])
const VALID_WAIT_UNTIL = new Set(["load", "domcontentloaded", "networkidle0"])

/**
 * Read MA_FETCH_* env vars and shape them into BuildArgvOptions.
 * Throws BackendInputError on invalid input.
 *
 * Exported so tests can exercise validation paths without spawning.
 */
export function parseEnv(env: Record<string, string | undefined>): BuildArgvOptions {
  const url = env.MA_FETCH_URL?.trim()
  if (!url) throw new BackendInputError("MA_FETCH_URL is required")

  const format = env.MA_FETCH_FORMAT?.trim()
  if (!format) throw new BackendInputError("MA_FETCH_FORMAT is required")
  if (!VALID_FORMATS.has(format)) {
    throw new BackendInputError(
      `MA_FETCH_FORMAT must be one of: ${[...VALID_FORMATS].join(", ")} (got: ${format})`,
    )
  }

  const waitUntil = env.MA_FETCH_WAIT_UNTIL?.trim()
  if (!waitUntil) throw new BackendInputError("MA_FETCH_WAIT_UNTIL is required")
  if (!VALID_WAIT_UNTIL.has(waitUntil)) {
    throw new BackendInputError(
      `MA_FETCH_WAIT_UNTIL must be one of: ${[...VALID_WAIT_UNTIL].join(", ")} (got: ${waitUntil})`,
    )
  }

  const timeoutRaw = env.MA_FETCH_TIMEOUT_SEC?.trim()
  if (!timeoutRaw) throw new BackendInputError("MA_FETCH_TIMEOUT_SEC is required")
  const timeoutSec = Number(timeoutRaw)
  if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > 600) {
    throw new BackendInputError(
      `MA_FETCH_TIMEOUT_SEC must be an integer between 1 and 600 (got: ${timeoutRaw})`,
    )
  }

  const selector = env.MA_FETCH_SELECTOR?.trim() || undefined
  const evalExpr = env.MA_FETCH_EVAL || undefined // don't trim - JS may want leading/trailing ws
  const userAgent = env.MA_FETCH_USER_AGENT?.trim() || undefined
  const proxy = env.MA_FETCH_PROXY?.trim() || undefined
  const storageDir = env.MA_FETCH_STORAGE_DIR?.trim() || undefined

  // Newline-separated list (`\n` is the one byte POSIX paths cannot contain).
  // Empty / whitespace-only entries are dropped.
  const extRaw = env.MA_FETCH_EXTENSIONS
  const extensions =
    extRaw && extRaw.length > 0
      ? extRaw
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined

  return {
    url,
    format: format as BuildArgvOptions["format"],
    waitUntil: waitUntil as BuildArgvOptions["waitUntil"],
    timeoutSec: Math.floor(timeoutSec),
    selector,
    evalExpr,
    userAgent,
    proxy,
    extensions: extensions && extensions.length > 0 ? extensions : undefined,
    storageDir,
  }
}

// ---------------------------------------------------------------------------
// Subprocess entry point
// ---------------------------------------------------------------------------

/**
 * When this file is executed directly (not imported), parse env, spawn
 * obscura, and propagate its stdout/stderr/exit verbatim.
 *
 * Bun's `import.meta.main` is true when this file is the entry point.
 */
if (import.meta.main) {
  await main()
}

async function main(): Promise<never> {
  let opts: BuildArgvOptions
  try {
    opts = parseEnv(process.env as Record<string, string | undefined>)
  } catch (e) {
    const msg = e instanceof BackendInputError ? e.message : String(e)
    process.stderr.write(`[ma-fetch/obscura] ${msg}\n`)
    process.exit(2)
  }

  const bin = process.env.MA_FETCH_BIN?.trim() || "obscura"
  const argv = [bin, ...buildArgv(opts)]

  const proc = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await proc.exited
  process.exit(code ?? 1)
}
