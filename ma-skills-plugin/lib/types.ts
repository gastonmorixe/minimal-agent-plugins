/**
 * Local type stubs mirroring minimal-agent's plugin contract.
 *
 * Why local copies?
 *   External plugins don't sit inside the agent's source tree, so the
 *   `../../../src/plugins/types.ts` import that embedded plugins use
 *   isn't available. TypeScript types are structural and erased at
 *   runtime — keeping a local mirror lets us type-check this plugin
 *   standalone (`bun test`, editor IntelliSense) while staying byte-
 *   compatible with the agent's actual contract.
 *
 * If the agent's contract changes, update this file. The fields we
 * actually use are intentionally narrow: see {@link TUIContext} (just
 * `trigger`, `cwd`, `packageDir`, `env`, `abort`, `stderr`) and
 * {@link TUIResult} (the `tool_result` variant only).
 *
 * @module lib/types
 */

// ---------------------------------------------------------------------------
// TUI tool-handler contract (mirrors minimal-agent's src/plugins/types.ts)
// ---------------------------------------------------------------------------

export interface ToolTrigger {
  type: "tool"
  /** The tool name as declared in the manifest (`Skill`). */
  name: string
  /** Raw input the model produced. Validate before use. */
  input: Record<string, unknown>
}

/**
 * Mirror of minimal-agent's `PluginLogger`. Eight severity methods, all
 * `(source, message, sd?) => void`. The loader auto-prefixes `source`
 * with the plugin id so emits land in the file log + TUI surface tagged
 * with which plugin spoke. `sd` is structured data (free-form record).
 */
export interface PluginLogger {
  emergency(source: string, message: string, sd?: Record<string, unknown>): void
  alert(source: string, message: string, sd?: Record<string, unknown>): void
  critical(source: string, message: string, sd?: Record<string, unknown>): void
  error(source: string, message: string, sd?: Record<string, unknown>): void
  warn(source: string, message: string, sd?: Record<string, unknown>): void
  notice(source: string, message: string, sd?: Record<string, unknown>): void
  info(source: string, message: string, sd?: Record<string, unknown>): void
  debug(source: string, message: string, sd?: Record<string, unknown>): void
}

export interface TUIContext {
  trigger: ToolTrigger | { type: "inline_tag"; [k: string]: unknown }
  /** Absolute path to the plugin's own directory. */
  packageDir: string
  /** The agent's current working directory. */
  cwd: string
  /** Environment dict. Loader injects `TUI_PLUGIN_PROTOCOL=1` and friends. */
  env: Record<string, string>
  /** Cancelled when the user aborts the turn or a timeout fires. */
  abort: AbortSignal
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  stderr: NodeJS.WriteStream
  /** Plugin-scoped diagnostic logger. Auto-prefixed with this plugin's id. */
  log: PluginLogger
}

export type TUIResult =
  | {
      kind: "tool_result"
      /** Sent back to the model. */
      content: string
      is_error?: boolean
      /** Optional ANSI body rendered in the transcript (no truncation). */
      display?: string
      /** Optional header content slot (after the icon+label). */
      displayHeader?: string
      /** Optional footer content slot (after the closing glyph). */
      displayFooter?: string
      /**
       * Truncation context for minimal-agent's universal output guardrail.
       * Lets the agent emit `[truncated: shown N/M B, ...]` notices if the
       * body exceeds the global cap. `_` prefix is the convention for fields
       * stripped before the result is sent to the model.
       */
      _truncCtx?: { totalBytes: number; totalLines: number; tool?: string }
    }
  | { kind: "rendered"; ansi: string }
  | { kind: "interactive_result"; value: unknown }

export type TUIHandler = (ctx: TUIContext) => Promise<TUIResult>

// ---------------------------------------------------------------------------
// Prompt-fragment contract
// ---------------------------------------------------------------------------

export interface PromptFragmentContext {
  /** Plugin package directory (absolute). */
  packageDir: string
  /** The agent's current working directory at load time. */
  cwd: string
  /** Plugin-scoped environment. The loader injects `TUI_PLUGIN_PROTOCOL=1`. */
  env: Record<string, string>
  /** Agent session id (UUID v4), when available. */
  sessionId?: string
  /** Aborts when the fragment's timeout fires. */
  abort: AbortSignal
  /** Diagnostic stream. */
  stderr: NodeJS.WriteStream
  /** Plugin-scoped diagnostic logger. Auto-prefixed with this plugin's id. */
  log: PluginLogger
  /**
   * Register dynamic tool handlers into the PluginLoader's tool index.
   * Used to push skill-declared tools into the model's function list.
   * Absent for subprocess fragments; consumers must narrow:
   * `ctx.registerDynamicTools?.(...)`.
   */
  registerDynamicTools?: (handlers: unknown[]) => void
}

export type PromptFragmentHandler = (ctx: PromptFragmentContext) => Promise<string> | string

// ---------------------------------------------------------------------------
// Skill domain types
// ---------------------------------------------------------------------------

/**
 * Origin root of a discovered skill. Order matches precedence: lower index
 * wins. See {@link DiscoveryRootKey} in `lib/config.ts` for the config-level
 * keys (which may include additional opt-in roots like `projectClaudeCode`).
 */
export type SkillScope = "project" | "projectClaudeCode" | "homeShared" | "userAgent" | "extra"

/**
 * Fully parsed + validated frontmatter from a SKILL.md.
 *
 * Spec reference: https://agentskills.io/specification#frontmatter
 */
export interface SkillFrontmatter {
  /** Required. `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤64 chars, must match dir name. */
  name: string
  /** Required. 1–1024 chars, no XML tags. What+when. */
  description: string
  /** Optional. License name or reference. */
  license?: string
  /** Optional. ≤500 chars. Environment requirements. */
  compatibility?: string
  /** Optional. String-keyed string-valued map for client extensions. */
  metadata?: Record<string, string>
  /** Optional, experimental. Space-separated tokens, parsed into a list. */
  allowedTools?: string[]
  /** Optional. Parsed from `metadata.tools` JSON if present + valid. */
  tools?: ToolSpec[]
}

// ---------------------------------------------------------------------------
// Skill-declared tool types
// ---------------------------------------------------------------------------

/**
 * A tool declared by a skill, either statically in `SKILL.md` frontmatter
 * (`metadata.tools`) or programmatically via `scripts/register.ts`.
 *
 * After validation, each ToolSpec is converted to a {@link ResolvedHandler}
 * and pushed into the PluginLoader's tool index via
 * `registerDynamicTools`. The model sees these tools alongside built-ins
 * like `Bash` and `Read`.
 */
export interface ToolSpec {
  /** Unique tool name. Must not collide with any core or plugin tool. */
  name: string
  /** Model-facing description — what the tool does and when to use it. */
  description: string
  /** Standard JSON Schema for the tool's input parameters. */
  parameters: Record<string, unknown>
  /** How the tool call is executed. */
  handler: ScriptHandler | InlineHandler
  /** Ordering hint: higher values appear earlier in the model's tool list. Default 0. */
  priority?: number
  /** Metadata tags for the harness, e.g. `["emergency"]`, `["requires-confirmation"]`. */
  tags?: string[]
}

/** Execute a script in the skill's directory. */
export interface ScriptHandler {
  type: "script"
  /** Path relative to the skill directory, e.g. `"scripts/police_911"`. */
  path: string
  /**
   * Template for mapping input params to CLI arguments.
   * `"{details}"` substitutes the `details` param into the argument list.
   * When absent, params are serialized as JSON on stdin.
   */
  argTemplate?: string
  /** Per-call timeout in milliseconds. Default 30_000. */
  timeoutMs?: number
}

/** Inject a rendered prompt into the model's context. */
export interface InlineHandler {
  type: "inline"
  /** Template string rendered with tool input params via `{param_name}` substitution. */
  promptTemplate: string
}

/**
 * A skill that declared tools and should NOT appear in the skills catalog.
 * Its tools are registered directly into the model's function list.
 */
export interface ToolizedSkill extends Skill {
  /** Validated tool specs (both from metadata.tools and scripts/register.ts). */
  tools: ToolSpec[]
}

/**
 * A discovered skill on disk. The `body` is the markdown after the closing
 * `---` of the frontmatter, loaded lazily by the `Skill read` action — not
 * by discovery.
 */
export interface Skill {
  /** Validated frontmatter. */
  front: SkillFrontmatter
  /** Absolute path to the skill's directory (parent of SKILL.md). */
  dir: string
  /** Absolute path to SKILL.md itself. */
  skillMdPath: string
  /** Which root tier this skill came from. */
  scope: SkillScope
}

/**
 * A discovered SKILL.md that failed validation. Surfaced in `Skill list`
 * output so the user can fix it; never returned by `Skill read` etc.
 */
export interface BrokenSkill {
  /** Best-effort dir-name-derived id (may not match a valid `name`). */
  dirName: string
  /** Absolute path to the would-be skill dir. */
  dir: string
  /** Validation errors. */
  errors: string[]
  scope: SkillScope
}

/**
 * Discovery result. Skills are deduplicated by `name` according to scope
 * precedence; shadowed skills are reported separately for diagnostics.
 *
 * Toolized skills (those that declared tools via `metadata.tools` or
 * `scripts/register.ts`) are routed to a separate `toolized` array and
 * excluded from the `skills` catalog. They appear as first-class tools
 * in the model's function list instead.
 */
export interface DiscoveryResult {
  /** Validated, non-shadowed prose skills (no tools declared). Keyed insertion order = walk order. */
  skills: Skill[]
  /** Skills that declared tools and should be registered as functions, not listed in the catalog. */
  toolized?: ToolizedSkill[]
  /** SKILL.md files that failed validation. */
  broken: BrokenSkill[]
  /** Skills shadowed by a higher-precedence skill of the same name. */
  shadowed: Array<{ skill: Skill; shadowedBy: SkillScope }>
}
