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
 * Load tools programmatically from `scripts/register.ts` in a skill directory.
 *
 * If `scripts/register.ts` exists, it is dynamically imported. If its default
 * export is a function, that function is called with a `registerTool` callback
 * that validates and collects ToolSpec objects.
 *
 * Never throws — all errors are logged to stderr and the offending tool or
 * module is skipped.
 *
 * @param skillDir - Absolute path to the skill's directory.
 * @returns Collected validated ToolSpec[].
 */
export async function loadScriptedTools(skillDir: string): Promise<ToolSpec[]> {
  const registerPath = resolve(skillDir, "scripts", "register.ts")

  if (!existsSync(registerPath)) {
    return []
  }

  const tools: ToolSpec[] = []

  const registerTool = (def: unknown): void => {
    const v = validateToolSpec(def)
    if (v.ok) {
      tools.push(v.value)
    } else {
      console.error(`[ma-skills] invalid tool spec in ${registerPath}: ${v.errors.join("; ")}`)
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
    console.error(
      `[ma-skills] failed to load scripted tools from ${registerPath}: ${
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
 * @returns An object compatible with ResolvedHandler.
 */
export function toolSpecToHandler(spec: ToolSpec, skillDir: string): unknown {
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

      const proc = Bun.spawn([scriptPath, ...args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: skillDir,
        env: {
          ...(process.env as Record<string, string>),
        },
      })

      const timer = setTimeout(() => {
        proc.kill("SIGKILL")
      }, timeoutMs)

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
