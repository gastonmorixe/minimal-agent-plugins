/**
 * Claude Code dialect adapter (SPEC.md "Claude Code adapter").
 *
 * Sources, in order: `~/.claude/settings.json`, `<project>/.claude/settings.json`,
 * `<project>/.claude/settings.local.json`. Claude facts come from
 * `research/hooks-claude-vs-codex/raw/claude/hooks-reference.md` (cited as
 * `raw:<line>`). Depends on the engine's canonical types and the pure trust
 * hash (`engine/hash.ts`) only: never on the engine runtime, on native, or on
 * another adapter.
 *
 * @module adapters/claude/adapter
 */

import { join } from "node:path"

import { parseJsonc } from "@minimal-agent/core/plugin-api/utils/jsonc"

import { hookContentHash, TrustKeyAllocator } from "../../engine/hash.ts"
import type {
  CanonicalHook,
  DiscoverEnv,
  HookDialectAdapter,
  HookHandlerSpec,
  HookSupport,
  InvocationContext,
  MatchContext,
  ParseResult,
  SourceRef,
} from "../../engine/types.ts"

import { decodeClaudeOutcome } from "./decode.ts"
import { type ClaudeEventInfo, claudeEvent, claudeStdin, isObj } from "./events.ts"
import { compileClaudeMatcher, type IfRule, ifRuleMatches, parseIfRule } from "./matcher.ts"

type Obj = Record<string, unknown>

function strMap(v: unknown): Record<string, string> | undefined {
  if (!isObj(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x
  return out
}

function parseHandler(raw: Obj): { handler: HookHandlerSpec; support: HookSupport } {
  const type = raw.type
  if (type === "command" && typeof raw.command === "string") {
    const args = Array.isArray(raw.args)
      ? raw.args.filter((a): a is string => typeof a === "string")
      : undefined
    // `shell: "powershell"` has no meaning off Windows, so only `bash` is kept (raw:461).
    return {
      handler: {
        type: "command",
        command: raw.command,
        ...(args ? { args } : {}),
        ...(raw.shell === "bash" ? { shell: "bash" as const } : {}),
      },
      support: "ok",
    }
  }
  if (type === "http" && typeof raw.url === "string") {
    const headers = strMap(raw.headers)
    const allowed = Array.isArray(raw.allowedEnvVars)
      ? raw.allowedEnvVars.filter((a): a is string => typeof a === "string")
      : undefined
    return {
      handler: {
        type: "http",
        url: raw.url,
        ...(headers ? { headers } : {}),
        ...(allowed ? { allowedEnvVars: allowed } : {}),
      },
      support: "ok",
    }
  }
  // `prompt`, `agent`, `mcp_tool`, an unknown type or a missing field: loaded, not run.
  return {
    handler: { type: "command", command: typeof raw.command === "string" ? raw.command : "" },
    support: "unsupported-type",
  }
}

/** Build the matcher closure for one hook: event split, matcher, then `if`. */
export function claudeMatches(
  info: ClaudeEventInfo,
  matcher: string | undefined,
  ifText: string | undefined,
): { fn: (ctx: MatchContext) => boolean; error?: string } {
  // A matcher on an event without matcher support is ignored (raw:343).
  const m = info.matchValue ? compileClaudeMatcher(matcher) : { test: () => true }
  let rule: IfRule | undefined
  let never = false
  if (ifText !== undefined) {
    // On non-tool events, a hook with `if` set never runs (raw:428).
    if (!info.toolEvent) never = true
    else {
      rule = parseIfRule(ifText)
      if (!rule) never = true
    }
  }
  const fn = (ctx: MatchContext): boolean => {
    if (never) return false
    const p = isObj(ctx.payload) ? ctx.payload : {}
    if (info.accepts && !info.accepts(p)) return false
    if (info.matchValue && !m.test(info.matchValue(p))) return false
    if (rule) {
      const input = isObj(p.input) ? p.input : {}
      const cwd = typeof p.cwd === "string" ? p.cwd : ""
      return ifRuleMatches(rule, {
        tool: typeof p.tool === "string" ? p.tool : undefined,
        input,
        cwd,
      })
    }
    return true
  }
  return { fn, ...("error" in m && m.error ? { error: m.error } : {}) }
}

/** Parse Claude settings text into canonical hooks. Never throws. */
export function parseClaude(source: SourceRef, text: string): ParseResult {
  const warnings: string[] = []
  const hooks: CanonicalHook[] = []
  const keys = new TrustKeyAllocator()
  let doc: unknown
  try {
    doc = parseJsonc(text)
  } catch (e) {
    return { hooks, warnings: [`${source.path}: parse error: ${String(e)}`] }
  }
  if (!isObj(doc)) return { hooks, warnings: [`${source.path}: top level is not an object`] }
  const out: ParseResult = { hooks, warnings }
  // `disableAllHooks` (raw:738). This turns off the claude dialect only.
  if (doc.disableAllHooks === true) out.disableAll = true
  if (doc.hooks === undefined) return out
  if (!isObj(doc.hooks)) {
    warnings.push(`${source.path}: "hooks" is not an object`)
    return out
  }
  for (const [event, groups] of Object.entries(doc.hooks)) {
    if (!Array.isArray(groups)) {
      warnings.push(`${source.path}: hooks.${event} is not an array`)
      continue
    }
    const info = claudeEvent(event)
    groups.forEach((group, gi) => {
      if (!isObj(group) || !Array.isArray(group.hooks)) {
        warnings.push(`${source.path}: hooks.${event}[${gi}] has no hooks array`)
        return
      }
      const matcher = typeof group.matcher === "string" ? group.matcher : undefined
      group.hooks.forEach((rawHook, hi) => {
        if (!isObj(rawHook)) {
          warnings.push(`${source.path}: hooks.${event}[${gi}].hooks[${hi}] is not an object`)
          return
        }
        hooks.push(buildHook(source, event, info, matcher, keys, rawHook, warnings))
      })
    })
  }
  return out
}

function buildHook(
  source: SourceRef,
  event: string,
  info: ClaudeEventInfo | undefined,
  matcher: string | undefined,
  keys: TrustKeyAllocator,
  rawHook: Obj,
  warnings: string[],
): CanonicalHook {
  const { handler, support } = parseHandler(rawHook)
  const ifText = typeof rawHook.if === "string" ? rawHook.if : undefined
  const m = info ? claudeMatches(info, matcher, ifText) : { fn: () => false }
  if ("error" in m && m.error) {
    warnings.push(`${source.path}: bad matcher ${JSON.stringify(matcher)}: ${m.error}`)
  }
  // `timeout` in seconds, defaults per event (raw:429).
  const timeoutMs =
    typeof rawHook.timeout === "number" && rawHook.timeout > 0
      ? Math.round(rawHook.timeout * 1000)
      : (info?.defaultTimeoutMs ?? 600_000)
  const channel = info?.channel ?? ""
  const isAsync = rawHook.async === true
  // `onFailure: "block"` makes errors and timeouts block (raw:942).
  const failClosed = rawHook.onFailure === "block"
  // Events that share a channel, and `if` filters, must not dedup into one another.
  const split = event === "PostToolUseFailure" || event === "SubagentStop" ? event : ""
  const dedupScope = split || ifText ? JSON.stringify([split, ifText ?? ""]) : undefined
  return {
    // The event name (not the channel) keeps keys unique: two events share tool.didInvoke.
    // The key comes from the hook identity, not its position (review MINOR 6).
    trustKey: keys.next(`claude:${source.id}:${event}`, {
      ...(matcher !== undefined && info?.matchValue ? { matcher } : {}),
      ...(ifText !== undefined ? { filter: ifText } : {}),
      handler,
    }),
    dialect: "claude",
    source,
    channel,
    dialectEvent: event,
    ...(matcher !== undefined ? { matcher } : {}),
    ...(ifText !== undefined ? { filter: ifText } : {}),
    ...(dedupScope ? { dedupScope } : {}),
    matches: m.fn,
    handler,
    timeoutMs,
    async: isAsync,
    failClosed,
    ...(typeof rawHook.statusMessage === "string" ? { statusMessage: rawHook.statusMessage } : {}),
    support: info ? support : "unsupported-event",
    contentHash: hookContentHash({
      dialect: "claude",
      channel,
      event,
      // A matcher on an event without matcher support is ignored (raw:343).
      ...(matcher !== undefined && info?.matchValue ? { matcher } : {}),
      ...(ifText !== undefined ? { filter: ifText } : {}),
      handler,
      timeoutMs,
      async: isAsync,
      failClosed,
    }),
  }
}

/** Claude settings files for this home and project (SPEC.md "Source discovery"). */
export function discoverClaude(env: DiscoverEnv): SourceRef[] {
  const dir = join(env.projectRoot, ".claude")
  return [
    {
      id: "user",
      path: join(env.home, ".claude", "settings.json"),
      scope: "user",
      precedence: 0,
    },
    { id: "project", path: join(dir, "settings.json"), scope: "project", precedence: 1 },
    {
      id: "project-local",
      path: join(dir, "settings.local.json"),
      scope: "project",
      precedence: 2,
    },
  ]
}

/** Claude stdin and env for one call. */
export function encodeClaude(
  hook: CanonicalHook,
  _channel: string,
  payload: unknown,
  ctx: InvocationContext,
): { stdin: string; env: Record<string, string>; handler?: HookHandlerSpec } {
  const stdin = JSON.stringify(claudeStdin(hook.dialectEvent, payload, ctx))
  // CLAUDE_PROJECT_DIR is the project root (raw:495, raw:615).
  const env: Record<string, string> = { CLAUDE_PROJECT_DIR: ctx.projectDir }
  if (hook.source.pluginRoot) env.CLAUDE_PLUGIN_ROOT = hook.source.pluginRoot
  if (hook.source.pluginData) env.CLAUDE_PLUGIN_DATA = hook.source.pluginData
  const h = hook.handler
  if (h.type !== "command" || !h.args || h.args.length === 0) return { stdin, env }
  // Exec form: path placeholders are substituted into `command` and each
  // `args` element as plain strings (raw:468). Shell form leaves it to the
  // shell, which reads the exported env vars (raw:495).
  const sub = (v: string) => substitutePlaceholders(v, env)
  return { stdin, env, handler: { ...h, command: sub(h.command), args: h.args.map(sub) } }
}

const PLACEHOLDER = /\$\{(CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA)\}/g

/**
 * Replace `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}` and
 * `${CLAUDE_PLUGIN_DATA}` with values from `vars`. An unknown value stays as
 * written.
 */
export function substitutePlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (m, name: string) => vars[name] ?? m)
}

/** The Claude Code adapter instance. */
export const claudeAdapter: HookDialectAdapter = {
  id: "claude",
  discover: discoverClaude,
  parse: parseClaude,
  encodeInput: encodeClaude,
  decodeOutput: (hook, _channel, run) =>
    decodeClaudeOutcome(hook.dialectEvent, run, hook.failClosed, hook.source.scope),
}
