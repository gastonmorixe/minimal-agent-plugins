/**
 * Hash trust for config hooks (SPEC.md "Trust").
 *
 * State file: `<agent home>/hooks-state.json`, keyed by project root:
 * `{ "projects": { "<root>": { "trusted": true, "hooks": { "<trustKey>": { "trustedHash", "enabled" } } } } }`.
 * User-scope hooks are trusted implicitly. Project and plugin hooks need
 * project trust plus a hash match (`engine/hash.ts`). `MA_TRUST_HOOKS=1`
 * trusts all for one run.
 * No core project-trust concept was found (grep of core `src` and
 * `plugin-api/src` for trust names, 2026-11-15), so the plugin keeps its own.
 *
 * @module engine/trust
 */

import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import type { CanonicalHook } from "./types.ts"

/** Per-hook state. */
export interface HookState {
  trustedHash?: string
  enabled?: boolean
}

/** Per-project state. */
export interface ProjectState {
  trusted?: boolean
  hooks: Record<string, HookState>
}

/** Whole state file. */
export interface TrustStateFile {
  projects: Record<string, ProjectState>
}

/** Why a hook may not run. */
export type TrustVerdict = "trusted" | "untrusted-project" | "untrusted-hash" | "disabled"

/** Trust as `/hooks` shows it. `env` is `MA_TRUST_HOOKS=1` or `--trust-hooks`. */
export type TrustState = "trusted" | "untrusted" | "untrusted-hash" | "implicit-user" | "env"

/** Path of the state file under an agent home. */
export function trustStatePath(agentHome: string): string {
  return join(agentHome, "hooks-state.json")
}

/** Read and write the trust state. */
export class TrustStore {
  private cache: TrustStateFile | null = null

  /**
   * Create a store.
   *
   * @param path - State file path.
   * @param trustAll - `MA_TRUST_HOOKS=1`.
   */
  constructor(
    readonly path: string,
    readonly trustAll: boolean,
  ) {}

  /** Read the state (cached). Corrupt or missing gives an empty state. */
  read(): TrustStateFile {
    if (this.cache) return this.cache
    this.cache = this.readDisk()
    return this.cache
  }

  private readDisk(): TrustStateFile {
    try {
      if (existsSync(this.path)) {
        const raw: unknown = JSON.parse(readFileSync(this.path, "utf8"))
        if (raw && typeof raw === "object" && "projects" in raw) {
          const p = (raw as { projects: unknown }).projects
          if (p && typeof p === "object") return { projects: p as TrustStateFile["projects"] }
        }
      }
    } catch {
      // corrupt state: start empty, never throw
    }
    return { projects: {} }
  }

  /** Drop the cache so the next read hits the disk. */
  invalidate(): void {
    this.cache = null
  }

  /**
   * Apply one change to the state on disk. It re-reads the file first, so a
   * change from another session is kept (no lost update). The write is atomic
   * (unique temp file, then rename).
   */
  private update(root: string, change: (p: ProjectState) => void): void {
    const s = this.readDisk()
    const p = s.projects[root] ?? { hooks: {} }
    if (!p.hooks || typeof p.hooks !== "object") p.hooks = {}
    change(p)
    s.projects[root] = p
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`)
      renameSync(tmp, this.path)
    } catch (e) {
      // Do not leave the temp file behind, then report the error as before.
      rmSync(tmp, { force: true })
      throw e
    }
    this.cache = s
  }

  /** True when `root` is trusted (or `MA_TRUST_HOOKS=1`). */
  projectTrusted(root: string): boolean {
    return this.trustAll || this.read().projects[root]?.trusted === true
  }

  /** Decide whether a hook may run in `root`. */
  verdict(root: string, hook: CanonicalHook): TrustVerdict {
    const p = this.read().projects[root]
    const hs = p?.hooks?.[hook.trustKey]
    if (hs?.enabled === false) return "disabled"
    if (this.trustAll || hook.source.scope === "user") return "trusted"
    if (p?.trusted !== true) return "untrusted-project"
    if (hs?.trustedHash !== hook.contentHash) return "untrusted-hash"
    return "trusted"
  }

  /** The trust state shown by `/hooks` (enabled state is separate). */
  trustState(root: string, hook: CanonicalHook): TrustState {
    if (this.trustAll) return "env"
    if (hook.source.scope === "user") return "implicit-user"
    const p = this.read().projects[root]
    if (p?.trusted !== true) return "untrusted"
    return p.hooks?.[hook.trustKey]?.trustedHash === hook.contentHash ? "trusted" : "untrusted-hash"
  }

  /** False when the state file disables this key. */
  stateEnabled(root: string, trustKey: string): boolean {
    return this.read().projects[root]?.hooks?.[trustKey]?.enabled !== false
  }

  /** Trust the project and this hook's current hash. */
  trustHook(root: string, hook: CanonicalHook): void {
    this.update(root, (p) => {
      p.trusted = true
      p.hooks[hook.trustKey] = { ...p.hooks[hook.trustKey], trustedHash: hook.contentHash }
    })
  }

  /** Trust the project and the current hash of every hook, in one atomic write. */
  trustHooks(root: string, hooks: readonly CanonicalHook[]): void {
    this.update(root, (p) => {
      p.trusted = true
      for (const h of hooks)
        p.hooks[h.trustKey] = { ...p.hooks[h.trustKey], trustedHash: h.contentHash }
    })
  }

  /** Forget this hook's trusted hash. */
  untrustHook(root: string, hook: CanonicalHook): void {
    this.update(root, (p) => {
      const hs = p.hooks[hook.trustKey]
      if (hs) delete hs.trustedHash
    })
  }

  /** Enable or disable one hook by trust key. */
  setEnabled(root: string, trustKey: string, enabled: boolean): void {
    this.update(root, (p) => {
      p.hooks[trustKey] = { ...p.hooks[trustKey], enabled }
    })
  }
}
