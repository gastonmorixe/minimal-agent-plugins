/**
 * DiagnosticsService — the plugin's composition root (Facade).
 *
 * Wires detection → providers → runner under a config, and exposes the single
 * `check(path, text)` the hook handler calls. Holds the persistent runner for
 * the session (so the tsgo LSP child is reused across edits) and disposes it on
 * teardown.
 *
 * Built lazily + memoized per root, so the first relevant Edit boots the
 * server and subsequent edits reuse it. All construction is driven by
 * {@link detectTools}, so a project with no tools yields a no-op service.
 *
 * Phase 3: the session also keeps a {@link DiagnosticsServicePool} keyed by
 * workspace root so multi-package monorepos can host N persistent LSPs with an
 * LRU cap.
 *
 * @module plugins/diagnostics/lib/service
 */

import { realpathSync } from "node:fs"
import { basename } from "node:path"

import type { DiagnosticsConfig } from "./config.ts"
import { type DetectedTool, detectTools, detectToolsForFile, resolveBinUp } from "./detect.ts"
import { filterFindings, formatNote } from "./format-notes.ts"
import type { DiagnosticProvider } from "./provider.ts"
import { DiagnosticsRunner } from "./runner.ts"
import type { Finding } from "./types.ts"

/** Factory hooks injected for testability (real impls spawn processes). */
export interface ProviderFactories {
  /**
   * Persistent TypeScript LSP provider (`tsgo`, or TS7+ `tsc --lsp`). `id`
   * labels the finding source + status slot (`"tsgo"` or `"tsc"`).
   */
  makeTsLsp(bin: string, root: string, id: string): DiagnosticProvider
  makeBiome(bin: string, root: string): DiagnosticProvider
  makePrettier(bin: string, root: string): DiagnosticProvider
  makeOxlint(bin: string, root: string): DiagnosticProvider
  makeEslint(bin: string, root: string): DiagnosticProvider
  /** Spawn-per-call `tsc --noEmit` provider (TypeScript 6-and-earlier fallback). */
  makeTsc(bin: string, root: string): DiagnosticProvider
  makeTscDirect(bin: string, root: string): DiagnosticProvider
  makeSourceKit(bin: string, root: string): DiagnosticProvider
}

export interface ServiceCheckResult {
  /** Findings to render (already filtered by severity floor + cap). */
  findings: Finding[]
  /** Model-facing note lines (one per kept finding). */
  notes: string[]
  /** Providers that degraded this run. */
  degraded: string[]
}

/** Active persistent LSP descriptor for the live-area footer. */
export interface ActivePersistentProvider {
  /** Provider id (`tsc`, `tsgo`, `sourcekit-lsp`, …). */
  id: string
  /** Workspace / config root the server was booted for. */
  root: string
}

/**
 * Session-scoped facade over the diagnostics pipeline: lazily detects which
 * tools (biome/oxlint/tsgo) exist in the workspace, builds the provider
 * runner once, and turns raw findings into severity-filtered, capped,
 * model-facing note lines per checked file.
 */
export class DiagnosticsService {
  private runner: DiagnosticsRunner | null = null
  private built = false
  private tscBin: string | null = null
  /** Last time this service was used (for pool LRU). */
  lastUsedMs = 0

  constructor(
    private readonly root: string,
    private readonly config: DiagnosticsConfig,
    private readonly factories: ProviderFactories,
    /** Optional pre-detected tools (from {@link detectToolsForFile}). */
    private readonly preDetected?: DetectedTool[],
  ) {}

  /** Workspace root this service was constructed for. */
  get workspaceRoot(): string {
    return this.root
  }

  /** Build the runner from detected tools, honoring config gates. Memoized. */
  private ensureRunner(): DiagnosticsRunner | null {
    if (this.built) return this.runner
    this.built = true
    const detected = this.preDetected ?? detectTools(this.root)
    const providers: DiagnosticProvider[] = []
    for (const t of detected) {
      // Prefer tool-specific configRoot when present (Phase 2 multi-root detect).
      const cwd = t.configRoot ?? this.root
      if (t.id === "tsgo" && this.config.type) {
        providers.push(this.factories.makeTsLsp(t.bin, cwd, "tsgo"))
      } else if (t.id === "tsc" && this.config.type) {
        // TS7+ `tsc` is LSP-capable (detect.ts sets persistent=true); run it as
        // a persistent server. TS<=6 `tsc` stays a spawn-per-call fallback.
        if (t.persistent) {
          providers.push(this.factories.makeTsLsp(t.bin, cwd, "tsc"))
        } else {
          providers.push(this.factories.makeTsc(t.bin, cwd))
        }
        this.tscBin = t.bin
      } else if (t.id === "biome" && this.config.format) {
        providers.push(this.factories.makeBiome(t.bin, cwd))
      } else if (t.id === "prettier" && this.config.format) {
        providers.push(this.factories.makePrettier(t.bin, cwd))
      } else if (t.id === "oxlint" && this.config.lint) {
        providers.push(this.factories.makeOxlint(t.bin, cwd))
      } else if (t.id === "eslint" && this.config.lint) {
        providers.push(this.factories.makeEslint(t.bin, cwd))
      } else if (t.id === "sourcekit-lsp" && this.config.apple) {
        providers.push(this.factories.makeSourceKit(t.bin, cwd))
      }
    }
    this.runner =
      providers.length > 0
        ? new DiagnosticsRunner(providers, { timeoutMs: this.config.timeoutMs })
        : null

    // Stash tsc bin for the out-of-scope fallback. The detection loop may have
    // skipped tsc when tsgo was present (suppressedBy), so probe the binary
    // independently of detection. Walk ancestors so hoisted workspace installs
    // still feed the ad-hoc fallback.
    if (!this.tscBin) {
      this.tscBin = resolveBinUp("tsc", this.root)
    }

    return this.runner
  }

  /** True when at least one provider would handle `path`. */
  handles(path: string): boolean {
    const runner = this.ensureRunner()
    return runner?.handles(path) ?? false
  }

  /**
   * Run diagnostics for the proposed `text` at `path`, returning rendered
   * findings + model notes (filtered). Resolves with empty arrays when nothing
   * applies. Never throws.
   */
  async check(path: string, text: string): Promise<ServiceCheckResult> {
    this.lastUsedMs = Date.now()
    if (!this.config.enabled) return { findings: [], notes: [], degraded: [] }
    const runner = this.ensureRunner()
    if (!runner || !runner.handles(path)) return { findings: [], notes: [], degraded: [] }

    const report = await runner.check(path, text)
    let findings = report.findings
    let degraded = report.degraded

    // Out-of-scope fallback: if the normal providers returned nothing,
    // the file is outside project scope, and outOfScope is enabled, try
    // tsc-direct which bypasses the project config. Skip when the file
    // IS in type scope (clean file, not excluded) to avoid a wasted spawn.
    if (
      findings.length === 0 &&
      this.config.type &&
      this.config.outOfScope.enabled &&
      this.tscBin &&
      !runner.isInTypeScope(path)
    ) {
      const directProvider = this.factories.makeTscDirect(this.tscBin, this.root)
      if (directProvider.handles(path)) {
        try {
          const directFindings = await directProvider.check(path, text)
          findings = [...findings, ...directFindings]
        } catch {
          // direct provider failure: degrade silently
        }
      }
    }

    const kept = filterFindings(findings, {
      severityFloor: this.config.severityFloor,
      max: this.config.maxInline,
    })
    return { findings: kept, notes: kept.map(formatNote), degraded }
  }

  dispose(): void {
    this.runner?.dispose()
    this.runner = null
  }

  /** Returns ids of persistent LSP providers whose server is currently booted and alive. */
  getActivePersistentProviders(): string[] {
    return this.runner?.getActivePersistentProviders() ?? []
  }

  /** Active persistent providers with this service's workspace root. */
  getActivePersistentProvidersDetailed(): ActivePersistentProvider[] {
    return this.getActivePersistentProviders().map((id) => ({ id, root: this.root }))
  }
}

/** Default max concurrent workspace services (each may hold a persistent LSP). */
export const DEFAULT_SERVICE_POOL_MAX = 4

function workspaceKey(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    return root
  }
}

/**
 * LRU pool of {@link DiagnosticsService} instances keyed by workspace root.
 * Caps concurrent persistent LSP servers for multi-package sessions.
 */
export class DiagnosticsServicePool {
  private readonly map = new Map<string, DiagnosticsService>()

  constructor(
    private readonly config: DiagnosticsConfig,
    private readonly factories: ProviderFactories,
    private readonly maxServices: number = DEFAULT_SERVICE_POOL_MAX,
  ) {}

  /**
   * Get or create a service for `root`. Touches LRU. Evicts least-recently-used
   * when over capacity.
   */
  get(root: string, preDetected?: DetectedTool[]): DiagnosticsService {
    const key = workspaceKey(root)
    let svc = this.map.get(key)
    if (!svc) {
      this.evictIfNeeded()
      svc = new DiagnosticsService(root, this.config, this.factories, preDetected)
      this.map.set(key, svc)
    }
    svc.lastUsedMs = Date.now()
    return svc
  }

  /**
   * Resolve services for a file via {@link detectToolsForFile}, group tools by
   * configRoot, and run every applicable service. Merges findings.
   */
  async checkFile(
    filePath: string,
    text: string,
    fallbackRoot: string,
  ): Promise<ServiceCheckResult> {
    if (!this.config.enabled) return { findings: [], notes: [], degraded: [] }

    const detected = detectToolsForFile(filePath, { fallbackRoot })
    if (detected.length === 0) {
      // Last resort: single service at fallback / nearest project-ish root.
      const svc = this.get(fallbackRoot)
      if (!svc.handles(filePath)) return { findings: [], notes: [], degraded: [] }
      return svc.check(filePath, text)
    }

    // Group tools by configRoot so one DiagnosticsService per workspace.
    const byRoot = new Map<string, DetectedTool[]>()
    for (const t of detected) {
      const r = t.configRoot ?? fallbackRoot
      const list = byRoot.get(r) ?? []
      list.push(t)
      byRoot.set(r, list)
    }

    const findings: Finding[] = []
    const degraded: string[] = []
    let anyHandled = false

    for (const [root, tools] of byRoot) {
      const svc = this.get(root, tools)
      if (!svc.handles(filePath)) continue
      anyHandled = true
      const res = await svc.check(filePath, text)
      for (const f of res.findings) findings.push(f)
      for (const d of res.degraded) degraded.push(d)
    }

    if (!anyHandled) return { findings: [], notes: [], degraded: [] }

    const kept = filterFindings(findings, {
      severityFloor: this.config.severityFloor,
      max: this.config.maxInline,
    })
    return { findings: kept, notes: kept.map(formatNote), degraded }
  }

  getActivePersistentProvidersDetailed(): ActivePersistentProvider[] {
    const out: ActivePersistentProvider[] = []
    for (const svc of this.map.values()) {
      for (const p of svc.getActivePersistentProvidersDetailed()) out.push(p)
    }
    // Stable sort: by id then root basename.
    out.sort((a, b) => a.id.localeCompare(b.id) || basename(a.root).localeCompare(basename(b.root)))
    return out
  }

  dispose(): void {
    for (const s of this.map.values()) s.dispose()
    this.map.clear()
  }

  /** Test helper: number of live services. */
  get size(): number {
    return this.map.size
  }

  private evictIfNeeded(): void {
    while (this.map.size >= this.maxServices) {
      let oldestKey: string | null = null
      let oldestMs = Number.POSITIVE_INFINITY
      for (const [k, s] of this.map) {
        if (s.lastUsedMs < oldestMs) {
          oldestMs = s.lastUsedMs
          oldestKey = k
        }
      }
      if (oldestKey === null) break
      const victim = this.map.get(oldestKey)
      victim?.dispose()
      this.map.delete(oldestKey)
    }
  }
}
