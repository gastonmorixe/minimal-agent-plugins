/**
 * OpenCode client identity for the Zen and Go inference gateways.
 *
 * Shared byte for byte by `ma-llm-opencode-zen-plugin` and
 * `ma-llm-opencode-go-plugin`. Keep it self-contained: only `node:` modules and
 * type-only imports of the vendored canonical contract.
 *
 * Every gate value lives here, so a server-side change is a one-file fix.
 * Sources (opencode repo): UA `packages/core/src/app.ts:24-26`, session id
 * `packages/schema/src/identifier.ts:16-31`, project id
 * `packages/core/src/project.ts:287-397`, headers
 * `packages/core/src/session/model-request.ts:282-295`.
 *
 * @module opencode-identity
 */
import { execFileSync } from "node:child_process"
import { createHash, getRandomValues } from "node:crypto"

import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"

import type { CanonicalRequest } from "./lib/canonical-request.ts"

// ---------------------------------------------------------------------------
// Version and user agent
// ---------------------------------------------------------------------------

/** Env var that overrides the opencode version in the user agent. */
export const OPENCODE_VERSION_ENV = "MINIMAL_AGENT_OPENCODE_VERSION"
/** Version used when `opencode --version` is not available. */
export const OPENCODE_FALLBACK_VERSION = "2.0.32"
/** User-agent channel segment. */
export const OPENCODE_CHANNEL = "latest"
/** Client name in the user agent and `x-opencode-client`. */
export const OPENCODE_CLIENT_NAME = "minimal-agent"

const VERSION_TIMEOUT_MS = 2_000

let cachedInstalledVersion: string | null | undefined

/** Pull the first `x.y.z` out of `opencode --version` output. */
export function parseOpencodeVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1]
}

function installedOpencodeVersion(): string | null {
  if (cachedInstalledVersion !== undefined) return cachedInstalledVersion
  try {
    const out = execFileSync("opencode", ["--version"], {
      encoding: "utf8",
      timeout: VERSION_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    })
    cachedInstalledVersion = parseOpencodeVersion(out) ?? null
  } catch {
    cachedInstalledVersion = null
  }
  return cachedInstalledVersion
}

/**
 * Version for the user agent. The env override wins, then the installed
 * `opencode --version` (run once, cached), then {@link OPENCODE_FALLBACK_VERSION}.
 */
export function opencodeVersion(): string {
  const override = process.env[OPENCODE_VERSION_ENV]?.trim()
  if (override) return override
  return installedOpencodeVersion() ?? OPENCODE_FALLBACK_VERSION
}

/** `opencode/<channel>/<version>/<name>`. */
export function opencodeUserAgent(): string {
  return `opencode/${OPENCODE_CHANNEL}/${opencodeVersion()}/${OPENCODE_CLIENT_NAME}`
}

// ---------------------------------------------------------------------------
// Session id
// ---------------------------------------------------------------------------

const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastTimestamp = 0
let counter = 0

/**
 * Descending opencode identifier: 6 hex bytes of `~(ms * 4096 + counter)`,
 * then 14 random base62 chars.
 */
export function opencodeIdentifier(timestamp: number = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(counter))
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  const bytes = getRandomValues(new Uint8Array(14))
  return time + Array.from(bytes, (byte) => ID_CHARS[byte % 62]).join("")
}

const sessionIds = new Map<string, string>()

/**
 * The `ses_` id for one minimal-agent session. Stable for the life of the
 * process, so session affinity and the prompt cache key do not change.
 */
export function opencodeSessionId(maSessionId: string): string {
  let id = sessionIds.get(maSessionId)
  if (!id) {
    id = `ses_${opencodeIdentifier()}`
    sessionIds.set(maSessionId, id)
  }
  return id
}

/** Prompt cache key: the `ses_` id without its prefix. */
export function opencodePromptCacheKey(sessionId: string): string {
  return sessionId.startsWith("ses_") ? sessionId.slice(4) : sessionId
}

// ---------------------------------------------------------------------------
// Project id
// ---------------------------------------------------------------------------

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex")
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: VERSION_TIMEOUT_MS,
    })
  } catch {
    return undefined
  }
}

function remoteParts(host: string, name: string): string | undefined {
  const pathname = name
    .replace(/^\/+/, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "")
  if (!host || !pathname) return undefined
  return `${host.toLowerCase()}/${pathname}`
}

/** Normalize a git remote URL to `host/path`, or undefined for `file:` and junk. */
export function normalizeGitRemote(input: string): string | undefined {
  const parsed = URL.parse(input)
  if (parsed) {
    if (parsed.protocol === "file:") return undefined
    return remoteParts(parsed.hostname, parsed.pathname)
  }
  const scp = input.match(/^([^@/:]+@)?([^/:]+):(.+)$/)
  return scp?.[2] && scp[3] ? remoteParts(scp[2], scp[3]) : undefined
}

/**
 * opencode project id for a directory: `sha1("git-remote:" + host/path)` of
 * origin, else the first sorted root commit, else `sha1("directory:" + dir)`.
 */
export function computeOpencodeProjectId(directory: string): string {
  const remote = git(directory, ["remote", "get-url", "origin"])?.trim()
  const normalized = remote ? normalizeGitRemote(remote) : undefined
  if (normalized) return sha1(`git-remote:${normalized}`)
  const roots = git(directory, ["rev-list", "--max-parents=0", "HEAD"])
  const root = roots
    ?.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()[0]
  if (root) return root
  return sha1(`directory:${directory}`)
}

let cachedProjectId: string | undefined

/** Project id for `process.cwd()`, computed once per process. */
export function opencodeProjectId(): string {
  cachedProjectId ??= computeOpencodeProjectId(process.cwd())
  return cachedProjectId
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/** Identity and session-affinity headers for one inference request. */
export function opencodeHeaders(opts: {
  /** The `ses_` id from {@link opencodeSessionId}. */
  sessionId: string
  orgId?: string
}): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": opencodeUserAgent(),
    "x-opencode-client": OPENCODE_CLIENT_NAME,
    "x-opencode-project": opencodeProjectId(),
    "x-opencode-session": opts.sessionId,
    "x-opencode-session-id": opts.sessionId,
    "x-session-affinity": opts.sessionId,
    "X-Session-Id": opts.sessionId,
  }
  if (opts.orgId) headers["x-org-id"] = opts.orgId
  return headers
}

// ---------------------------------------------------------------------------
// Tool name mapping (free-tier gate wants a tool named exactly `read`)
// ---------------------------------------------------------------------------

/** Host tool name. */
export const HOST_READ_TOOL = "Read"
/** Wire tool name the gateway expects. */
export const WIRE_READ_TOOL = "read"

/** True when the request declares a tool the gateway sees as `read`. */
export function hasReadTool(req: CanonicalRequest): boolean {
  return (req.tools ?? []).some((t) => t.name === HOST_READ_TOOL || t.name === WIRE_READ_TOOL)
}

/**
 * Rename the host `Read` tool to `read` in `tools`, history `tool_use` blocks,
 * and `toolChoice`. `renamed` is false (and the request is returned as is)
 * when there is no `Read` tool, or when a `read` tool already exists.
 */
export function toOpencodeToolNames(req: CanonicalRequest): {
  request: CanonicalRequest
  renamed: boolean
} {
  const tools = req.tools ?? []
  if (!tools.some((t) => t.name === HOST_READ_TOOL)) return { request: req, renamed: false }
  if (tools.some((t) => t.name === WIRE_READ_TOOL)) return { request: req, renamed: false }
  const rename = (name: string) => (name === HOST_READ_TOOL ? WIRE_READ_TOOL : name)
  const request: CanonicalRequest = {
    ...req,
    tools: tools.map((t) => (t.name === HOST_READ_TOOL ? { ...t, name: WIRE_READ_TOOL } : t)),
    messages: req.messages.map((m) =>
      m.content.some((b) => b.type === "tool_use" && b.name === HOST_READ_TOOL)
        ? {
            ...m,
            content: m.content.map((b) =>
              b.type === "tool_use" ? { ...b, name: rename(b.name) } : b,
            ),
          }
        : m,
    ),
  }
  if (req.toolChoice?.type === "tool" && req.toolChoice.name === HOST_READ_TOOL)
    request.toolChoice = { type: "tool", name: WIRE_READ_TOOL }
  return { request, renamed: true }
}

/** Map a streamed `tool_use_start` named `read` back to the host `Read`. */
export function fromOpencodeToolEvent(ev: CanonicalEvent): CanonicalEvent {
  if (ev.type === "tool_use_start" && ev.name === WIRE_READ_TOOL)
    return { ...ev, name: HOST_READ_TOOL }
  return ev
}

/** Stream wrapper for {@link fromOpencodeToolEvent}. */
export async function* fromOpencodeToolEvents(
  events: AsyncIterable<CanonicalEvent>,
): AsyncIterable<CanonicalEvent> {
  for await (const ev of events) yield fromOpencodeToolEvent(ev)
}
