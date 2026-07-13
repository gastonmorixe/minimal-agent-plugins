/**
 * TypeScript type-diagnostics provider over a PERSISTENT LSP server.
 *
 * This is the highest-value signal : type errors grep and lint can't see. A
 * persistent `<bin> --lsp -stdio` answers per-edit pulls in 2-3ms (vs ~316ms to
 * spawn `tsc --noEmit` cold), so the server is booted ONCE (lazily, on the
 * first TS check) and reused.
 *
 * The same invocation serves two binaries, keyed by {@link id}:
 *  - `"tsgo"` : the `@typescript/native-preview` Go compiler (TS7 preview).
 *  - `"tsc"`  : the stable `tsc` binary at TypeScript 7+ GA, which IS the
 *    native compiler and speaks the same `--lsp -stdio` protocol.
 * Detection ({@link detectTools}) decides which binary + id to construct here.
 *
 * Resilience: a {@link CircuitBreaker} guards the child. A crash/timeout
 * records a failure; once the breaker opens, checks return [] (degraded) until
 * a cooldown permits a restart trial. After too many trips the breaker goes
 * `dead` and the provider stays quiet for the session : never a crash, never a
 * hot restart loop.
 *
 * @module plugins/diagnostics/providers/ts-lsp-provider
 */
import { adaptLspDiagnostics } from "../adapters/lsp.ts"
import { CircuitBreaker } from "../lib/circuit-breaker.ts"
import { LspClient } from "../lib/lsp-client.ts"
import type { DiagnosticProvider } from "../lib/provider.ts"
import { isPathInTsconfigScope } from "../lib/tsconfig-scope.ts"
import type { Finding } from "../lib/types.ts"

const EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/**
 * Per-pull ceiling. Slightly under the runner's 2s budget so a wedged
 * server surfaces HERE (recording a breaker failure + disposing the
 * client) rather than timing out invisibly in the runner where the
 * breaker can't see it.
 */
const PULL_TIMEOUT_MS = 1800

/** Race `p` against a deadline. Rejects with `lsp pull timeout` on expiry. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_res, rej) => {
    timer = setTimeout(() => rej(new Error("lsp pull timeout")), ms)
  })
  return Promise.race([p, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  }) as Promise<T>
}

/**
 * Type-checking provider backed by a long-lived TypeScript LSP server
 * (`tsgo` or TS7+ `tsc`). Boots the server lazily (sharing one boot promise
 * across concurrent checks), pulls diagnostics per file with a timeout, and
 * wraps every interaction in a {@link CircuitBreaker} so a crashing or hung
 * server degrades the provider instead of stalling every Edit/Write.
 */
export class TsLspProvider implements DiagnosticProvider {
  readonly id: string
  readonly kind = "type" as const

  private client: LspClient | null = null
  private booting: Promise<LspClient> | null = null
  private readonly breaker = new CircuitBreaker({ maxFailures: 2, cooldownMs: 10_000, maxTrips: 5 })

  /**
   * Construct a persistent TypeScript LSP provider over the given binary.
   *
   * @param bin - absolute path to the LSP-capable binary (`tsgo` or `tsc`).
   * @param root - project root (LSP workspace + cwd).
   * @param id - finding/source id + status label. Defaults to `"tsgo"` for
   *   back-compat; the service passes `"tsc"` for the TS7 stable compiler.
   */
  constructor(
    private readonly bin: string,
    private readonly root: string,
    id = "tsgo",
  ) {
    this.id = id
  }

  handles(path: string): boolean {
    return EXT_RE.test(path)
  }

  /**
   * True when `path` is listed in the project's tsconfig program. Prevents the
   * service from treating clean in-project edits as out-of-scope and running
   * `tsc --ignoreConfig` (which cannot resolve `@/` path aliases).
   */
  inScope(path: string): boolean {
    return isPathInTsconfigScope(this.root, path)
  }

  /** Lazily boot (or reuse) the LSP child. Honors the breaker. */
  private async ensureClient(): Promise<LspClient | null> {
    if (!this.breaker.canAttempt()) return null
    if (this.client && !this.client.dead) return this.client
    if (this.booting) return this.booting

    this.booting = (async () => {
      const client = new LspClient([this.bin, "--lsp", "-stdio"], this.root)
      client.onExit(() => {
        // Unexpected exit: drop the handle so the next check reboots (subject
        // to the breaker). The breaker failure is recorded by `check`.
        if (this.client === client) this.client = null
      })
      try {
        await client.whenReady()
      } catch (err) {
        // Init failed (timeout / spawn error): DISPOSE so the spawned child
        // doesn't orphan. Without this, repeated half-open trials would
        // accumulate zombie server processes.
        try {
          client.dispose()
        } catch {
          /* already gone */
        }
        throw err
      }
      this.client = client
      return client
    })()

    try {
      const c = await this.booting
      return c
    } finally {
      this.booting = null
    }
  }

  async check(path: string, text: string): Promise<Finding[]> {
    let client: LspClient | null
    try {
      client = await this.ensureClient()
    } catch {
      this.breaker.recordFailure()
      return []
    }
    if (!client) return [] // breaker open/dead → degrade silently

    try {
      client.sync(path, text)
      // Bound the pull so a wedged-but-alive server records a breaker
      // failure instead of leaving the promise pending past the runner's
      // own timeout (which can't reach in here to cancel us).
      const items = await withTimeout(client.pullDiagnostics(path), PULL_TIMEOUT_MS)
      this.breaker.recordSuccess()
      return adaptLspDiagnostics(items, this.id)
    } catch {
      this.breaker.recordFailure()
      // Drop a possibly-wedged client so the next call reboots.
      if (this.client) {
        try {
          this.client.dispose()
        } catch {
          /* ignore */
        }
        this.client = null
      }
      return []
    }
  }

  dispose(): void {
    this.client?.dispose()
    this.client = null
  }

  isActive(): boolean {
    return this.client !== null && !this.client.dead
  }
}
