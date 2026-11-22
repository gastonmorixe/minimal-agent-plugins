/**
 * Structural copies of the CLI UI extension types (PLAN 4.3, 14 B-3). The
 * plugin does not import from the CLI. A CLI that does not give these
 * fields is valid: `setup` then does nothing.
 *
 * @module lib/host-types
 */

import type { SessionFileCreate } from "@minimal-agent/core/plugin-api/types/host-capabilities"
import type { UiSetupContext } from "@minimal-agent/core/plugin-api/types/plugin"
import type { SidebandApi } from "@minimal-agent/core/plugin-api/types/sideband"

/** `SessionFilesApi` bound to the active sid and to this plugin id. */
export interface BoundSessionFiles {
  create(name: string, data: string): SessionFileCreate
  stat(name: string): { bytes: number } | null
}

/** One paste, as the CLI gives it to a paste hook. */
export interface PasteEvent {
  /** The whole paste, markers removed, raw (no CRLF change). */
  readonly text: string
  readonly source: "bracketed" | "clipboard"
  /** The active session at paste time. */
  readonly sid: string | undefined
}

/** The event that a plugin paste hook gets. */
export interface PluginPasteEvent extends PasteEvent {
  readonly sideband: SidebandApi
  /** Present only when the manifest asks for `sessions:files` and a sid exists. */
  readonly files?: BoundSessionFiles
}

/** A plugin paste hook. */
export interface PluginPasteHook {
  id: string
  /** Higher runs first. The CLI clamps plugin hooks to 0..80. */
  priority?: number
  onPaste(ev: PluginPasteEvent): { insert: string } | null
}

/** A chip label for one inline kind. */
export interface ChipDef {
  kind: string
  label(attrs: Record<string, unknown>, known: boolean): string
}

/** The CLI fields on top of the core `UiSetupContext`. All optional. */
export interface CliUiExtensions {
  paste?: { registerHook(h: PluginPasteHook): () => void }
  chips?: { register(c: ChipDef): () => void }
}

/** The `ui.setup` context that this plugin reads. */
export type PasteUiContext = UiSetupContext &
  CliUiExtensions & {
    /** The plugin logger, when the host gives one. */
    readonly log?: { warn(source: string, message: string): void }
  }
