/**
 * Prompt store: one file per prompt under `<root>/`, name `<slug>.md`.
 *
 * Pure-ish: every filesystem access goes through {@link StoreDeps}, so tests
 * inject a temp directory and never touch the user's real library.
 *
 * Scope model:
 *   - `user`:    `<agentHome>/prompts/`            (default)
 *   - `project`: `<cwd>/.agents/prompts/`          (opt-in via config)
 *
 * Precedence: project wins over user, mirroring the skills convention.
 *
 * @module lib/store
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { agentHome } from "./agent-home.ts"
import { type PromptFrontmatter, parsePromptFile, serializePromptFile } from "./frontmatter.ts"

export type PromptScope = "user" | "project"

/** A prompt as loaded from disk. */
export interface Prompt {
  slug: string
  description: string
  metadata?: Record<string, string>
  body: string
  scope: PromptScope
  /** Absolute path to the `.md` file. */
  path: string
}

/** A prompt file that failed to parse. Never returned as a usable prompt. */
export interface BrokenPrompt {
  slug: string
  path: string
  scope: PromptScope
  errors: string[]
}

export interface LoadResult {
  prompts: Prompt[]
  broken: BrokenPrompt[]
}

export interface StoreDeps {
  /** Absolute paths for each scope, in precedence order (lowest first). */
  roots: Array<{ scope: PromptScope; dir: string }>
  /** Max body bytes. */
  maxBodyBytes: number
  /** Max prompt count across all roots. */
  maxPrompts: number
  /** Slug validator. Returns an error string, or null when valid. */
  validateSlug?: (slug: string) => string | null
  // Injectable fs (defaults to node:fs).
  readDir?: (dir: string) => string[]
  readFile?: (path: string) => string | null
  writeFile?: (path: string, data: string) => void
  exists?: (path: string) => boolean
  mkdirp?: (dir: string) => void
  remove?: (path: string) => void
}

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024
export const DEFAULT_MAX_PROMPTS = 500

/** Slug grammar: unambiguous next to the `&` token regex. */
export const SLUG_RE = /^[a-zA-Z0-9_-]+$/
export const MAX_SLUG_LEN = 64

/** Names that would shadow a command or confuse the user. */
export const RESERVED_SLUGS = new Set(["help", "quit", "exit"])

/** Validate a slug. Returns an error string, or null when valid. */
export function validateSlug(slug: string): string | null {
  if (slug.length === 0) return "name is empty"
  if (slug.length > MAX_SLUG_LEN) return `name is longer than ${MAX_SLUG_LEN} characters`
  if (!SLUG_RE.test(slug)) {
    return "name may only contain letters, digits, hyphen, and underscore"
  }
  if (RESERVED_SLUGS.has(slug.toLowerCase())) return `name "${slug}" is reserved`
  return null
}

/** Default roots from the environment: user scope, plus optional project. */
export function defaultRoots(
  env: Record<string, string> = process.env as Record<string, string>,
  cwd: string = process.cwd(),
  includeProject = false,
): Array<{ scope: PromptScope; dir: string }> {
  const roots: Array<{ scope: PromptScope; dir: string }> = []
  if (includeProject) roots.push({ scope: "project", dir: join(cwd, ".agents", "prompts") })
  roots.push({ scope: "user", dir: join(agentHome(env), "prompts") })
  return roots
}

/** Build deps with real fs wired in. */
export function defaultDeps(
  env: Record<string, string> = process.env as Record<string, string>,
  cwd: string = process.cwd(),
  includeProject = false,
  overrides: Partial<StoreDeps> = {},
): StoreDeps {
  return {
    roots: defaultRoots(env, cwd, includeProject),
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    maxPrompts: DEFAULT_MAX_PROMPTS,
    validateSlug,
    readDir: (dir) => {
      try {
        return readdirSync(dir)
      } catch {
        return []
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8")
      } catch {
        return null
      }
    },
    writeFile: (path, data) => writeFileSync(path, data, "utf8"),
    exists: (path) => existsSync(path),
    mkdirp: (dir) => mkdirSync(dir, { recursive: true }),
    remove: (path) => rmSync(path),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Load every prompt across all roots. The first root with a slug wins. */
export function loadPrompts(deps: StoreDeps): LoadResult {
  const bySlug = new Map<string, Prompt>()
  const broken: BrokenPrompt[] = []

  for (const root of deps.roots) {
    const entries = (deps.readDir ?? (() => []))(root.dir)
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue
      const path = join(root.dir, entry)
      const raw = (deps.readFile ?? (() => null))(path)
      if (raw === null) continue
      const fileSlug = entry.slice(0, -3)

      const parsed = parsePromptFile(raw)
      if (parsed.front === null) {
        broken.push({ slug: fileSlug, path, scope: root.scope, errors: parsed.errors })
        continue
      }
      // Frontmatter name wins over the filename.
      const slug = parsed.front.name || fileSlug
      // Roots are ordered highest-precedence first, so the FIRST occurrence
      // of a slug wins (project shadows user).
      if (bySlug.has(slug)) continue
      bySlug.set(slug, {
        slug,
        description: parsed.front.description,
        ...(parsed.front.metadata ? { metadata: parsed.front.metadata } : {}),
        body: parsed.body.replace(/\s+$/, ""),
        scope: root.scope,
        path,
      })
    }
  }

  const prompts = [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug))
  return { prompts, broken }
}

/** Find one prompt by slug (case-insensitive). */
export function findPrompt(result: LoadResult, slug: string): Prompt | undefined {
  const lower = slug.toLowerCase()
  return result.prompts.find((p) => p.slug.toLowerCase() === lower)
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export type WriteResult = { ok: true; prompt: Prompt } | { ok: false; error: string }

/** The user-scope directory, which is where writes land. */
function userRoot(deps: StoreDeps): string {
  const user = deps.roots.find((r) => r.scope === "user")
  if (!user) throw new Error("store: no user root configured")
  return user.dir
}

/**
 * Create a prompt. Fails on collision unless `overwrite` is set.
 * Writes always land in the user scope.
 */
export function createPrompt(
  deps: StoreDeps,
  input: { name: string; description: string; body: string; overwrite?: boolean },
): WriteResult {
  const slugError = (deps.validateSlug ?? validateSlug)(input.name)
  if (slugError) return { ok: false, error: slugError }

  const bodyBytes = Buffer.byteLength(input.body, "utf8")
  if (bodyBytes > deps.maxBodyBytes) {
    return {
      ok: false,
      error: `body is ${bodyBytes} bytes, over the ${deps.maxBodyBytes} byte limit`,
    }
  }

  const existing = loadPrompts(deps)
  if (existing.prompts.length >= deps.maxPrompts && !findPrompt(existing, input.name)) {
    return { ok: false, error: `library is at the ${deps.maxPrompts} prompt limit` }
  }
  if (findPrompt(existing, input.name) && !input.overwrite) {
    return {
      ok: false,
      error: `a prompt named "${input.name}" already exists (pass overwrite: true)`,
    }
  }

  const dir = userRoot(deps)
  ;(deps.mkdirp ?? (() => {}))(dir)
  const path = join(dir, `${input.name}.md`)
  const front: PromptFrontmatter = { name: input.name, description: input.description }
  ;(deps.writeFile ?? (() => {}))(path, serializePromptFile(front, input.body))

  return {
    ok: true,
    prompt: {
      slug: input.name,
      description: input.description,
      body: input.body.replace(/\s+$/, ""),
      scope: "user",
      path,
    },
  }
}

/** Update an existing prompt's body and/or description, optionally renaming. */
export function editPrompt(
  deps: StoreDeps,
  input: { name: string; description?: string; body?: string; rename?: string },
): WriteResult {
  const existing = loadPrompts(deps)
  const prompt = findPrompt(existing, input.name)
  if (!prompt) return { ok: false, error: `no prompt named "${input.name}"` }

  const nextSlug = input.rename ?? prompt.slug
  const slugError = (deps.validateSlug ?? validateSlug)(nextSlug)
  if (slugError) return { ok: false, error: slugError }
  if (nextSlug !== prompt.slug && findPrompt(existing, nextSlug)) {
    return { ok: false, error: `a prompt named "${nextSlug}" already exists` }
  }

  const nextBody = input.body ?? prompt.body
  const bodyBytes = Buffer.byteLength(nextBody, "utf8")
  if (bodyBytes > deps.maxBodyBytes) {
    return {
      ok: false,
      error: `body is ${bodyBytes} bytes, over the ${deps.maxBodyBytes} byte limit`,
    }
  }

  const nextDesc = input.description ?? prompt.description
  const front: PromptFrontmatter = {
    name: nextSlug,
    description: nextDesc,
    ...(prompt.metadata ? { metadata: prompt.metadata } : {}),
  }

  // Rewrite in place at the prompt's own scope so a project prompt stays put.
  const targetDir = prompt.path.slice(0, prompt.path.lastIndexOf("/"))
  const targetPath = join(targetDir, `${nextSlug}.md`)
  ;(deps.writeFile ?? (() => {}))(targetPath, serializePromptFile(front, nextBody))
  if (nextSlug !== prompt.slug && targetPath !== prompt.path) {
    ;(deps.remove ?? (() => {}))(prompt.path)
  }

  return {
    ok: true,
    prompt: {
      slug: nextSlug,
      description: nextDesc,
      ...(prompt.metadata ? { metadata: prompt.metadata } : {}),
      body: nextBody.replace(/\s+$/, ""),
      scope: prompt.scope,
      path: targetPath,
    },
  }
}

export type DeleteResult = { ok: true; path: string } | { ok: false; error: string }

/** Delete a prompt. Errors when the name does not exist (no silent no-op). */
export function deletePrompt(deps: StoreDeps, name: string): DeleteResult {
  const existing = loadPrompts(deps)
  const prompt = findPrompt(existing, name)
  if (!prompt) return { ok: false, error: `no prompt named "${name}"` }
  ;(deps.remove ?? (() => {}))(prompt.path)
  return { ok: true, path: prompt.path }
}
