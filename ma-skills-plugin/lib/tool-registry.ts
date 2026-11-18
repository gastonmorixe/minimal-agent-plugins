/**
 * ToolSpec validation + handler factory for skill-declared tools.
 *
 * Skills can declare tools in two ways:
 * 1. Statically in `SKILL.md` frontmatter `metadata.tools` JSON.
 * 2. Programmatically via `scripts/register.ts` in the skill directory.
 *
 * This module validates raw ToolSpec objects (from untrusted sources),
 * loads scripted tools from `scripts/register.ts`, and converts
 * validated ToolSpecs into objects compatible with the PluginLoader's
 * `ResolvedHandler` interface — ready to push via `registerDynamicTools`.
 *
 * @module lib/tool-registry
 */

import { existsSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { childEnv } from "@minimal-agent/core/plugin-api/utils/self-spawn"

import type { ToolSpec } from "./types.ts"

// ---------------------------------------------------------------------------
// validateToolSpec
// ---------------------------------------------------------------------------

/**
 * Validate a ToolSpec object from an untrusted source (SKILL.md metadata.tools
 * JSON or a scripts/register.ts callback).
 *
 * Returns `{ ok: true, value }` on success, `{ ok: false, errors }` on
 * failure. The errors array is always non-empty on failure.
 */
export function validateToolSpec(
  raw: unknown,
): { ok: true; value: ToolSpec } | { ok: false; errors: string[] } {
  const errors: string[] = []

  if (raw == null || typeof raw !== "object") {
    return { ok: false, errors: ["ToolSpec must be a non-null object"] }
  }

  const obj = raw as Record<string, unknown>

  // name: non-empty string, PascalCase (matching core tool convention)
  if (typeof obj.name !== "string" || obj.name.length === 0) {
    errors.push("name must be a non-empty string")
  } else if (!/^[A-Z][A-Za-z0-9]*$/.test(obj.name)) {
    errors.push(
      `name "${obj.name}" must be PascalCase (start with uppercase, letters and digits only, e.g. "Police911")`,
    )
  }

  // description: non-empty string
  if (typeof obj.description !== "string" || obj.description.length === 0) {
    errors.push("description must be a non-empty string")
  } else if (obj.description.length > 1024) {
    errors.push(`description exceeds 1024 characters (got ${obj.description.length})`)
  }

  // parameters: object
  if (
    obj.parameters == null ||
    typeof obj.parameters !== "object" ||
    Array.isArray(obj.parameters)
  ) {
    errors.push("parameters must be a non-null, non-array object")
  }

  // handler: object with valid type
  if (obj.handler == null || typeof obj.handler !== "object" || Array.isArray(obj.handler)) {
    errors.push("handler must be a non-null, non-array object")
  } else {
    const h = obj.handler as Record<string, unknown>
    const handlerType = h.type

    if (handlerType !== "script" && handlerType !== "inline") {
      errors.push(`handler.type must be "script" or "inline", got "${String(handlerType)}"`)
    }

    if (handlerType === "script") {
      if (typeof h.path !== "string" || h.path.length === 0) {
        errors.push("script handler requires a non-empty path string")
      }
      // argTemplate is optional, but if present must be a string
      if (h.argTemplate !== undefined && typeof h.argTemplate !== "string") {
        errors.push("script handler argTemplate must be a string when present")
      }
      // timeoutMs is optional, but if present must be a number
      if (h.timeoutMs !== undefined && typeof h.timeoutMs !== "number") {
        errors.push("script handler timeoutMs must be a number when present")
      }
    }

    if (handlerType === "inline") {
      if (typeof h.promptTemplate !== "string" || h.promptTemplate.length === 0) {
        errors.push("inline handler requires a non-empty promptTemplate string")
      }
    }
  }

  // priority: optional, must be a number if present
  if (obj.priority !== undefined && typeof obj.priority !== "number") {
    errors.push("priority must be a number when present")
  }

  // tags: optional, must be an array of strings if present
  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags)) {
      errors.push("tags must be an array when present")
    } else {
      for (let i = 0; i < obj.tags.length; i++) {
        if (typeof obj.tags[i] !== "string") {
          errors.push(`tags[${i}] must be a string`)
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return { ok: true, value: obj as unknown as ToolSpec }
}

// ---------------------------------------------------------------------------
// loadScriptedTools
// ---------------------------------------------------------------------------

/**
 * Receives a problem found while loading scripted tools. `data.file` is the
 * `scripts/register.ts` path. A caller with a plugin logger passes
 * `(m, d) => ctx.log.warn("tool-registry", m, d)`.
 */
export type ToolRegistryWarn = (
  message: string,
  data?: Record<string, string | number | boolean>,
) => void

/**
 * Load tools programmatically from `scripts/register.ts` in a skill directory.
 *
 * If `scripts/register.ts` exists, it is dynamically imported. If its default
 * export is a function, that function is called with a `registerTool` callback
 * that validates and collects ToolSpec objects.
 *
 * Never throws — each problem goes to `warn` (when given) and the offending
 * tool or module is skipped. Without `warn` the problems are dropped: this
 * module has no logger of its own and never writes to the process streams.
 *
 * @param skillDir - Absolute path to the skill's directory.
 * @param warn - Optional sink for an invalid tool spec or a failed import.
 * @returns Collected validated ToolSpec[].
 */
export async function loadScriptedTools(
  skillDir: string,
  warn?: ToolRegistryWarn,
): Promise<ToolSpec[]> {
  const registerPath = resolve(skillDir, "scripts", "register.ts")

  if (!existsSync(registerPath)) {
    return []
  }

  const tools: ToolSpec[] = []

  const report = (message: string): void => {
    try {
      warn?.(message, { file: registerPath })
    } catch {
      // Reporting is best effort: it must not break loading the other tools.
    }
  }

  const registerTool = (def: unknown): void => {
    const v = validateToolSpec(def)
    if (v.ok) {
      tools.push(v.value)
    } else {
      report(`invalid tool spec in ${registerPath}: ${v.errors.join("; ")}`)
    }
  }

  try {
    const url = pathToFileURL(registerPath).href
    const mod = (await import(url)) as { default?: unknown }
    const fn = mod.default
    if (typeof fn === "function") {
      await fn(registerTool)
    }
  } catch (e) {
    report(
      `failed to load scripted tools from ${registerPath}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  }

  return tools
}

// ---------------------------------------------------------------------------
// toolSpecToHandler
// ---------------------------------------------------------------------------

/**
 * The env a skill script runs with: `base` (default `process.env`) minus
 * `BUN_BE_BUN` (core `childEnv`).
 *
 * Skill scripts are user files on disk, run directly so their shebang picks
 * the interpreter (`#!/bin/sh`, `#!/usr/bin/env python3`, `#!/usr/bin/env bun`).
 * They are deliberately NOT run through the agent binary as a runtime
 * (`BUN_BE_BUN=1 <binary> <script>`): that env var would then sit in the
 * script's environment and leak into everything it starts, so a
 * `minimal-agent` it launched would boot as the plain `bun` CLI. A `.ts` skill
 * script therefore needs its own runtime on PATH, like any other interpreter.
 */
export function skillScriptEnv(
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  return childEnv(base)
}

/**
 * SIGKILL a detached skill script and its process group (negative pid), so
 * grandchildren die too. Falls back to the single pid when the group kill
 * fails. Never throws.
 */
function killScriptGroup(proc: { readonly pid: number; kill(sig?: number | string): void }): void {
  if (proc.pid > 0) {
    try {
      process.kill(-proc.pid, "SIGKILL")
      return
    } catch {
      // group gone or not a leader: fall through to the single pid
    }
  }
  try {
    proc.kill("SIGKILL")
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------
// Live script groups: killed when the host process exits (fix-3i)
// ---------------------------------------------------------------------------

/**
 * Pids of detached skill scripts whose process group may still hold a live
 * process. Each pid is also its pgid (`detached: true` calls `setsid()`).
 *
 * A detached script leaves the CLI session, so a terminal-close SIGHUP never
 * reaches it, and Bun kills no child on exit. ONE lazy `process.on("exit")`
 * listener SIGKILLs every group in this set. The `exit` event fires on
 * `process.exit()` and when the loop drains
 * (https://nodejs.org/api/process.html#event-exit), never on SIGKILL or on a
 * signal that has no listener. Core does the same for its own detached spawns
 * (`minimal-agent-core/src/infra/child-registry.ts`).
 *
 * While the CLI lives, a normal script exit kills nothing: a background child
 * that the script left keeps running, and its group stays in the set until it
 * is empty.
 */
const liveScriptGroups = new Set<number>()
let exitListenerInstalled = false

/** True while the process group `pgid` has at least one member. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    // ESRCH: empty group. EPERM: a reused id we cannot signal, so not ours.
    return false
  }
}

/** Drop each tracked group that has no live member. */
function pruneScriptGroups(): void {
  for (const pgid of liveScriptGroups) {
    if (!groupAlive(pgid)) liveScriptGroups.delete(pgid)
  }
}

/** SIGKILL every tracked group. Synchronous: an `exit` listener cannot await. */
function killScriptGroupsOnExit(): void {
  for (const pgid of liveScriptGroups) {
    try {
      process.kill(-pgid, "SIGKILL")
    } catch {
      // group already gone
    }
  }
  liveScriptGroups.clear()
}

/** Track a script group. Skips pid 1 and lower (`kill(-1)` hits every user process) and our own pid. */
function trackScriptGroup(pgid: number): void {
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) return
  pruneScriptGroups()
  liveScriptGroups.add(pgid)
  if (!exitListenerInstalled) {
    exitListenerInstalled = true
    process.on("exit", killScriptGroupsOnExit)
  }
}

/** Drop a group after its script exited, only when the group is empty. */
function releaseScriptGroupIfEmpty(pgid: number): void {
  if (liveScriptGroups.has(pgid) && !groupAlive(pgid)) liveScriptGroups.delete(pgid)
}

/** Snapshot of the tracked script group pids (tests and diagnostics). */
export function liveScriptGroupPids(): number[] {
  return [...liveScriptGroups]
}

/** Test seams for {@link toolSpecToHandler}. */
export interface ToolHandlerOptions {
  /** Base env for script handlers. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/**
 * Convert a validated ToolSpec into an object structurally compatible with
 * the PluginLoader's `ResolvedHandler` interface.
 *
 * The returned object has `definition`, `entryAbsolute`, and `invoke` fields
 * matching the shape that `registerDynamicTools` expects. The `invoke`
 * function dispatches to either a script (spawning it as a subprocess) or
 * an inline handler (rendering the prompt template with input params).
 *
 * @param spec - A validated ToolSpec.
 * @param skillDir - Absolute path to the skill's directory.
 * @param opts - Test seams (base env).
 * @returns An object compatible with ResolvedHandler.
 */
export function toolSpecToHandler(
  spec: ToolSpec,
  skillDir: string,
  opts: ToolHandlerOptions = {},
): unknown {
  const handlerId = `dynamic:${spec.name}`

  const definition = {
    id: handlerId,
    trigger: {
      type: "tool" as const,
      tool: {
        name: spec.name,
        description: spec.description,
        input_schema: spec.parameters as Record<string, unknown>,
      },
    },
    handler: {
      type: "module" as const,
      path: `.dynamic/${spec.name}.ts`,
    },
    interactive: false,
  }

  const invoke = async (ctx: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const triggerInput = (ctx.trigger as Record<string, unknown> | undefined)?.input as
      | Record<string, unknown>
      | undefined
    const input = triggerInput ?? {}

    if (spec.handler.type === "script") {
      // Resolve handler path RELATIVE to the skill directory.
      // Guard against path traversal: after resolving `..` segments,
      // the result MUST still be within the skill directory.
      const rawPath = resolve(skillDir, spec.handler.path)
      let realSkillDir: string
      try {
        realSkillDir = realpathSync(skillDir)
      } catch {
        realSkillDir = resolve(skillDir)
      }
      let scriptPath: string
      try {
        scriptPath = realpathSync(rawPath)
        if (!scriptPath.startsWith(`${realSkillDir}/`) && scriptPath !== realSkillDir) {
          return {
            kind: "tool_result",
            content: `Skill script path escapes skill directory: ${spec.handler.path}`,
            is_error: true,
          }
        }
      } catch {
        // Path doesn't exist — still check the non-resolved form.
        if (!rawPath.startsWith(`${realSkillDir}/`) && rawPath !== realSkillDir) {
          return {
            kind: "tool_result",
            content: `Skill script path escapes skill directory: ${spec.handler.path}`,
            is_error: true,
          }
        }
        scriptPath = rawPath
      }

      if (!existsSync(scriptPath)) {
        return {
          kind: "tool_result",
          content: `Skill script not found: ${spec.handler.path}`,
          is_error: true,
        }
      }

      const timeoutMs = spec.handler.timeoutMs ?? 30_000
      const argTemplate = spec.handler.argTemplate

      // Build args from argTemplate, or default to empty (input on stdin)
      const args: string[] = []
      if (argTemplate) {
        const parts = argTemplate.split(/\s+/)
        for (const part of parts) {
          args.push(part.replace(/\{(.+?)\}/g, (_m, key: string) => String(input[key] ?? "")))
        }
      }

      // `detached` puts the script in its own process group, so a timeout or
      // an abort can SIGKILL the whole group, grandchildren included. A
      // normal exit kills nothing: a skill may start a service on purpose.
      // The group is tracked, so it dies when the host process exits.
      // tty effect: `setsid()` leaves the script with no controlling tty.
      // stdio are pipes, so normal I/O is the same, but an open of
      // `/dev/tty` fails in the script.
      const proc = Bun.spawn([scriptPath, ...args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: skillDir,
        env: skillScriptEnv(opts.env),
        detached: true,
      })
      trackScriptGroup(proc.pid)

      const killTree = () => killScriptGroup(proc)
      const timer = setTimeout(killTree, timeoutMs)
      const abort = ctx.abort instanceof AbortSignal ? ctx.abort : undefined
      if (abort?.aborted) killTree()
      else abort?.addEventListener("abort", killTree, { once: true })

      try {
        if (argTemplate) {
          // Input passed via CLI args; close stdin
          void proc.stdin.end()
        } else {
          // Pass input as JSON on stdin
          void proc.stdin.write(new TextEncoder().encode(JSON.stringify(input)))
          void proc.stdin.end()
        }

        const output = await new Response(proc.stdout).text()
        const exitCode = await proc.exited

        if (exitCode !== 0) {
          const errOutput = await new Response(proc.stderr).text()
          return {
            kind: "tool_result",
            content: `Script exited with code ${exitCode}${errOutput ? `: ${errOutput.trim()}` : ""}`,
            is_error: true,
          }
        }

        return {
          kind: "tool_result",
          content: output.trimEnd() || "[script produced no output]",
        }
      } catch (e) {
        return {
          kind: "tool_result",
          content: `Script error: ${e instanceof Error ? e.message : String(e)}`,
          is_error: true,
        }
      } finally {
        clearTimeout(timer)
        abort?.removeEventListener("abort", killTree)
        // Check the group only after the leader exited and was reaped. On the
        // error path the stdout read can throw before `exited` settles.
        const release = () => releaseScriptGroupIfEmpty(proc.pid)
        if (proc.exitCode !== null || proc.signalCode !== null) release()
        else void proc.exited.then(release, release)
      }
    }

    // Inline handler: render promptTemplate with input substitution
    let rendered = spec.handler.promptTemplate
    rendered = rendered.replace(/\{(\w+)\}/g, (_m, key: string) =>
      key in input ? String(input[key]) : `{${key}}`,
    )

    return {
      kind: "tool_result",
      content: rendered,
    }
  }

  return {
    definition,
    entryAbsolute: skillDir,
    invoke,
  }
}
