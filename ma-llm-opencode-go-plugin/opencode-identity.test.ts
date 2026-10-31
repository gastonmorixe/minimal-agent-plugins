import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import { userText } from "@minimal-agent/core/plugin-api/llm/canonical-messages"

import type { CanonicalRequest } from "./lib/canonical-request.ts"
import {
  computeOpencodeProjectId,
  fromOpencodeToolEvent,
  fromOpencodeToolEvents,
  normalizeGitRemote,
  OPENCODE_FALLBACK_VERSION,
  OPENCODE_VERSION_ENV,
  opencodeHeaders,
  opencodeIdentifier,
  opencodeProjectId,
  opencodePromptCacheKey,
  opencodeSessionId,
  opencodeUserAgent,
  opencodeVersion,
  parseOpencodeVersion,
  toOpencodeToolNames,
} from "./opencode-identity.ts"

const SES_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const TMP_ROOT = join(import.meta.dir, "tmp")
mkdirSync(TMP_ROOT, { recursive: true })
const tmpDirs: string[] = []

function tmpDir(): string {
  const dir = mkdtempSync(join(TMP_ROOT, "identity-"))
  tmpDirs.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim()
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  try {
    rmdirSync(TMP_ROOT)
  } catch {
    // not empty: something else uses tmp/
  }
})

function withVersionEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env[OPENCODE_VERSION_ENV]
  if (value === undefined) delete process.env[OPENCODE_VERSION_ENV]
  else process.env[OPENCODE_VERSION_ENV] = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env[OPENCODE_VERSION_ENV]
    else process.env[OPENCODE_VERSION_ENV] = prev
  }
}

describe("version and user agent", () => {
  it("parses x.y.z out of opencode --version output", () => {
    expect(parseOpencodeVersion("opencode v2.0.32\n")).toBe("2.0.32")
    expect(parseOpencodeVersion("1.18.0")).toBe("1.18.0")
    expect(parseOpencodeVersion("nope")).toBeUndefined()
  })

  it("env override wins", () => {
    withVersionEnv("9.8.7", () => {
      expect(opencodeVersion()).toBe("9.8.7")
      expect(opencodeUserAgent()).toBe("opencode/latest/9.8.7/minimal-agent")
    })
  })

  it("without override uses x.y.z (installed or fallback)", () => {
    withVersionEnv(undefined, () => {
      expect(opencodeVersion()).toMatch(/^\d+\.\d+\.\d+$/)
      expect(opencodeUserAgent()).toMatch(/^opencode\/latest\/\d+\.\d+\.\d+\/minimal-agent$/)
    })
    expect(OPENCODE_FALLBACK_VERSION).toBe("2.0.32")
  })
})

describe("session id", () => {
  it("matches the opencode ses_ format", () => {
    for (let i = 0; i < 50; i++) expect(`ses_${opencodeIdentifier()}`).toMatch(SES_RE)
  })

  it("encodes the descending timestamp like opencode", () => {
    const ts = 1_760_000_000_000
    const id = opencodeIdentifier(ts)
    const expected = ~(BigInt(ts) * 0x1000n + 1n)
    const hex = Array.from({ length: 6 }, (_, i) =>
      Number((expected >> BigInt(40 - 8 * i)) & 0xffn)
        .toString(16)
        .padStart(2, "0"),
    ).join("")
    expect(id.slice(0, 12)).toBe(hex)
    // Same ms: counter increments, so the prefix differs.
    expect(opencodeIdentifier(ts).slice(0, 12)).not.toBe(hex)
  })

  it("is stable per minimal-agent session and distinct across sessions", () => {
    const a = opencodeSessionId("ma-session-a")
    expect(a).toMatch(SES_RE)
    expect(opencodeSessionId("ma-session-a")).toBe(a)
    expect(opencodeSessionId("ma-session-b")).not.toBe(a)
  })

  it("cache key drops the ses_ prefix", () => {
    expect(opencodePromptCacheKey("ses_abc")).toBe("abc")
    expect(opencodePromptCacheKey("plain")).toBe("plain")
  })
})

describe("project id", () => {
  it("normalizes remotes like opencode", () => {
    expect(normalizeGitRemote("https://GitHub.com/a/b.git")).toBe("github.com/a/b")
    expect(normalizeGitRemote("git@github.com:a/b.git")).toBe("github.com/a/b")
    expect(normalizeGitRemote("ssh://git@github.com/a/b/")).toBe("github.com/a/b")
    expect(normalizeGitRemote("file:///x/y")).toBeUndefined()
  })

  it("uses the root commit when there is no origin", () => {
    const dir = tmpDir()
    git(dir, "init", "-q")
    git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "root")
    const root = git(dir, "rev-list", "--max-parents=0", "HEAD")
    expect(computeOpencodeProjectId(dir)).toBe(root)
  })

  it("uses sha1(git-remote:host/path) when origin exists", () => {
    const dir = tmpDir()
    git(dir, "init", "-q")
    git(dir, "remote", "add", "origin", "git@github.com:acme/widget.git")
    const want = createHash("sha1").update("git-remote:github.com/acme/widget").digest("hex")
    expect(computeOpencodeProjectId(dir)).toBe(want)
  })

  it("uses sha1(directory:cwd) outside a repo or with no commits", () => {
    const dir = tmpDir()
    git(dir, "init", "-q")
    const want = createHash("sha1").update(`directory:${dir}`).digest("hex")
    expect(computeOpencodeProjectId(dir)).toBe(want)
  })

  it("caches the process project id", () => {
    expect(opencodeProjectId()).toBe(opencodeProjectId())
  })
})

describe("headers", () => {
  it("returns the full identity set", () => {
    const sessionId = opencodeSessionId("hdr")
    const h = withVersionEnv("2.0.32", () => opencodeHeaders({ sessionId }))
    expect(h["user-agent"]).toBe("opencode/latest/2.0.32/minimal-agent")
    expect(h["x-opencode-client"]).toBe("minimal-agent")
    expect(h["x-opencode-project"]).toBe(opencodeProjectId())
    for (const k of [
      "x-opencode-session",
      "x-opencode-session-id",
      "x-session-affinity",
      "X-Session-Id",
    ])
      expect(h[k]).toBe(sessionId)
    expect(h["x-org-id"]).toBeUndefined()
    expect(opencodeHeaders({ sessionId, orgId: "org_1" })["x-org-id"]).toBe("org_1")
  })
})

describe("tool name mapping", () => {
  const readTool = { name: "Read", description: "read", inputSchema: { type: "object" } }
  const bashTool = { name: "Bash", description: "bash", inputSchema: { type: "object" } }
  const base: CanonicalRequest = {
    modelId: "m",
    messages: [
      userText("hi"),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { path: "a" } },
          { type: "tool_use", id: "t2", name: "Bash", input: {} },
        ],
      },
    ],
    tools: [readTool, bashTool],
    toolChoice: { type: "tool", name: "Read" },
  }

  it("renames Read to read in tools, history, and tool choice", () => {
    const { request, renamed } = toOpencodeToolNames(base)
    expect(renamed).toBe(true)
    expect(request.tools?.map((t) => t.name)).toEqual(["read", "Bash"])
    const blocks = request.messages[1]?.content ?? []
    expect(blocks.map((b) => (b.type === "tool_use" ? b.name : ""))).toEqual(["read", "Bash"])
    expect(request.toolChoice).toEqual({ type: "tool", name: "read" })
    // Input is not mutated.
    expect(base.tools?.[0]?.name).toBe("Read")
    expect(base.messages[1]?.content[0]).toMatchObject({ name: "Read" })
  })

  it("leaves requests without Read untouched", () => {
    const req = { ...base, tools: [bashTool], toolChoice: undefined }
    const { request, renamed } = toOpencodeToolNames(req)
    expect(renamed).toBe(false)
    expect(request).toBe(req)
  })

  it("maps tool_use_start read back to Read, only that name", async () => {
    const start: CanonicalEvent = { type: "tool_use_start", index: 0, id: "x", name: "read" }
    expect(fromOpencodeToolEvent(start)).toEqual({ ...start, name: "Read" })
    const other: CanonicalEvent = { type: "tool_use_start", index: 1, id: "y", name: "write" }
    expect(fromOpencodeToolEvent(other)).toBe(other)
    async function* src() {
      yield start
      yield other
    }
    const out: CanonicalEvent[] = []
    for await (const ev of fromOpencodeToolEvents(src())) out.push(ev)
    expect(out.map((e) => (e.type === "tool_use_start" ? e.name : ""))).toEqual(["Read", "write"])
  })
})
