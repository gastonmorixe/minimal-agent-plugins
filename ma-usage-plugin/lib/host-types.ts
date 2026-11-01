/**
 * Narrowed, hand-written mirrors of the host plugin-context shapes this
 * plugin reads: a MINIMAL SLICE (fields this plugin actually touches), not a
 * copy of any single `@minimal-agent/core/plugin-api` module -- it combines
 * pieces of `types/plugin` and `types/host-capabilities` and omits most of
 * each. The host's real, richer objects satisfy these structurally, so this
 * stays even though the plugin can now depend on `@minimal-agent/core`
 * (S42): keeping the slice narrow documents exactly what usage reads and
 * fails typecheck loudly if the host contract drops a field this plugin
 * needs, instead of drifting silently.
 *
 * @module usage/lib/host-types
 */

export type {
  UsageBreakdownRow,
  UsagePeriod,
  UsageReport,
  UsageTotals,
} from "@minimal-agent/core/plugin-api/utils/usage-report"

import type { UsagePeriod, UsageReport } from "@minimal-agent/core/plugin-api/utils/usage-report"

/** Fire-and-forget emit onto the shared plugin event bus. */
export type EmitFn = (channel: string, payload?: unknown) => void

/** Folded usage reports exposed by the host through the `usage:read` capability. */
export interface UsageReadApi {
  /** Fold usage for one period. */
  report(period: UsagePeriod): UsageReport
  /** Fold usage for every period from one scan. */
  reports(): Record<UsagePeriod, UsageReport>
}

/** Host capability slice granted to the usage plugin by manifest capability token. */
export interface PluginHost {
  usage?: UsageReadApi
}

/** Structured logger the host injects into command handlers. */
export interface PluginLogger {
  debug(scope: string, message: string): void
  info(scope: string, message: string): void
  warn(scope: string, message: string): void
  error(scope: string, message: string): void
}

/** Runtime context passed to slash-command handlers. Narrowed to fields usage reads. */
export interface CommandContext {
  name: string
  argv: string
  rawLine: string
  cwd: string
  env: Record<string, string>
  abort: AbortSignal
  log: PluginLogger
  emit: EmitFn
  host?: PluginHost
}

/** Framed notice block shape, included for structural compatibility. */
export interface CommandNoticeBlock {
  icon?: string
  title: string
  info?: string
  timestamp?: string
  body?: string[]
  footer?: string
  color?: string
}

/** Result variants produced by the usage command handler. */
export type CommandResult =
  | { kind: "notice"; lines?: string[]; block?: CommandNoticeBlock }
  | { kind: "error"; message: string }
  | { kind: "none" }

/** Runtime context passed to hook handlers. Narrowed to fields usage reads. */
export interface HookHandlerContext {
  packageDir: string
  cwd: string
  env: Record<string, string>
  abort: AbortSignal
  emit: EmitFn
}
