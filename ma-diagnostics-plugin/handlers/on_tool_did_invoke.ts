/**
 * `tool.didInvoke` chain handler — the diagnostics plugin's single attach point.
 *
 * After an Edit/Write succeeds, this reads the just-written file and runs the
 * detected diagnostic tools (type/format/lint) for it, then pushes structured
 * `findings` (the agent renders them) and compact `notes` (the agent wraps them
 * in `<ma::agent::diagnostics>`) onto the chain payload. The agent owns all
 * rendering; this handler only supplies data.
 *
 * DECOUPLING: imports nothing from the agent's `src/`. The payload is a
 * structural contract (`findings`/`notes` accumulators). Heavy state (persistent
 * LSPs) lives in a session {@link DiagnosticsServicePool} keyed by workspace
 * root, disposed when the process exits.
 *
 * Defensive throughout: any failure returns the payload unchanged (the HookBus
 * also absorbs throws), so diagnostics can never break a tool result.
 *
 * @module plugins/diagnostics/handlers/on_tool_did_invoke
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { resolveAgentHome } from "../lib/agent-paths.ts"
import { loadConfig } from "../lib/config.ts"
import {
  type ActivePersistentProvider,
  DiagnosticsServicePool,
  type ProviderFactories,
} from "../lib/service.ts"
import { BiomeProvider } from "../providers/biome-provider.ts"
import { OxlintProvider } from "../providers/oxlint-provider.ts"
import { SourceKitLspProvider } from "../providers/sourcekit-lsp-provider.ts"
import { TsLspProvider } from "../providers/ts-lsp-provider.ts"
import { TscDirectProvider } from "../providers/tsc-direct-provider.ts"
import { TscSpawnProvider } from "../providers/tsc-provider.ts"

/** Minimal payload view (structural mirror of the agent's ToolDidInvokePayload). */
interface ToolDidInvokePayload {
  tool: string
  input: Record<string, unknown>
  cwd: string
  ok: boolean
  filePath?: string
  findings: unknown[]
  notes: string[]
}

interface ChainCtx {
  cwd: string
  env: Record<string, string>
  log?: (msg: string) => void
}

/** Real provider factories (spawn / LSP). Swapped for fakes in tests. */
const REAL_FACTORIES: ProviderFactories = {
  makeTsLsp: (bin, root, id) => new TsLspProvider(bin, root, id),
  makeTsc: (bin, root) => new TscSpawnProvider(bin, root),
  makeTscDirect: (bin, root) => new TscDirectProvider(bin, root),
  makeBiome: (bin, root) => new BiomeProvider(bin, root),
  makeOxlint: (bin, root) => new OxlintProvider(bin, root),
  makeSourceKit: (bin, root) => new SourceKitLspProvider(bin, root),
}

/** Session pool: multi-root services + LRU (Phase 3). */
let pool: DiagnosticsServicePool | null = null
let exitHookInstalled = false

/**
 * Collect active persistent LSP providers across all pooled roots.
 * Used by the live-area slot to render the LSP indicator in the TUI.
 */
export function getActivePersistentProviders(): string[] {
  const seen = new Set<string>()
  for (const p of getActivePersistentProvidersDetailed()) seen.add(p.id)
  return [...seen].sort()
}

/**
 * Active persistent providers with workspace roots (Phase 3 footer).
 */
export function getActivePersistentProvidersDetailed(): ActivePersistentProvider[] {
  return pool?.getActivePersistentProvidersDetailed() ?? []
}

/** Tolerant JSONC-ish parse (strip // and /* *​/ comments) without a dependency. */
function parseJsoncish(raw: string): unknown {
  const noComments = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
  try {
    return JSON.parse(noComments)
  } catch {
    return {}
  }
}

function configPath(): string {
  const override = process.env.MINIMAL_AGENT_CONFIG_PATH
  if (override) return override
  return join(resolveAgentHome(), "config.jsonc")
}

function ensurePool(): DiagnosticsServicePool {
  if (!pool) {
    const cfg = loadConfig(configPath(), parseJsoncish)
    pool = new DiagnosticsServicePool(cfg, REAL_FACTORIES)
  }
  if (!exitHookInstalled) {
    exitHookInstalled = true
    const dispose = () => {
      pool?.dispose()
      pool = null
    }
    // Bare signal handlers would DISABLE default termination when the host
    // app has none of its own (Ctrl-C swallowed by a cleanup hook). So:
    // dispose, then RE-RAISE. `once` has already removed this handler by
    // then, so the re-raised signal falls through to the host's handlers
    // (if any) or the default disposition (terminate). Host handlers are
    // never touched.
    process.once("exit", dispose)
    const onSignal = (sig: NodeJS.Signals) => () => {
      dispose()
      process.kill(process.pid, sig)
    }
    process.once("SIGINT", onSignal("SIGINT"))
    process.once("SIGTERM", onSignal("SIGTERM"))
  }
  return pool
}

/** Tools whose results carry a file we should diagnose. */
const FILE_MUTATING_TOOLS = new Set(["Edit", "Write"])

/**
 * Post-tool hook that lints a file right after a successful Edit/Write:
 * resolves the touched path, runs the diagnostics service on it, and appends
 * the findings to the tool result as model-facing notes. Best-effort
 * throughout; any internal failure leaves the payload unmodified rather than
 * breaking the tool call.
 */
export default async function onToolDidInvoke(
  payload: ToolDidInvokePayload,
  ctx: ChainCtx,
): Promise<{ payload: ToolDidInvokePayload } | void> {
  try {
    if (!payload || !payload.ok) return
    if (!FILE_MUTATING_TOOLS.has(payload.tool)) return
    const filePath =
      payload.filePath ??
      (typeof payload.input?.file_path === "string"
        ? (payload.input.file_path as string)
        : undefined)
    if (!filePath || !existsSync(filePath)) return

    const fallbackRoot = ctx.cwd || payload.cwd || process.cwd()

    // The Edit/Write already wrote the file: disk == proposed text.
    let text: string
    try {
      text = readFileSync(filePath, "utf8")
    } catch {
      return
    }

    const p = ensurePool()
    // Phase 2+3: per-tool config roots via detectToolsForFile, multi-root pool.
    const result = await p.checkFile(filePath, text, fallbackRoot)
    if (result.findings.length === 0 && result.notes.length === 0) return

    // Push onto the accumulators the agent reads back. The agent renders
    // `findings` into its own chrome and wraps `notes` in the annotation.
    for (const finding of result.findings) payload.findings.push(finding)
    for (const note of result.notes) payload.notes.push(note)
    return { payload }
  } catch (e) {
    ctx.log?.(`diagnostics handler error: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
}
