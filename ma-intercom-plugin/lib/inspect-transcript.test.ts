import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { resolveThresholds } from "./config.ts"
import type { RecordWindow } from "./host-types.ts"
import type { PresenceRecord } from "./presence.ts"
import { inspectPeer, type ServiceDeps } from "./service.ts"

const rec = {
  v: 1,
  sid: "peer-sid-0001",
  short: "peer-s",
  pid: 1,
  host: "h",
  ts: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:00.000Z",
  agentVersion: "0.1.0",
  model: "m",
  cwd: "/w",
  projectRoot: "/w",
  phase: "idle",
  activity: null,
} as unknown as PresenceRecord

/** Data-only host: no preview/summary/clipped/fullChars on the records. */
const win: RecordWindow = {
  sid: rec.sid,
  total: 2,
  firstIndex: 0,
  lastIndex: 1,
  items: [
    {
      index: 0,
      kind: "user",
      ts: "2026-01-01T10:11:12.000Z",
      previewChars: 200,
      parts: [{ kind: "text", text: "hello\n  world", toolName: null }],
    },
    {
      index: 1,
      kind: "assistant",
      ts: null,
      previewChars: 200,
      parts: [
        { kind: "thinking", text: "hmm", toolName: null },
        { kind: "tool_use", text: '{"a":1}', toolName: "Read" },
      ],
    },
  ],
} as unknown as RecordWindow

describe("inspectPeer transcript from data-only host", () => {
  it("builds rows from parts with no preview field", async () => {
    const home = mkdtempSync(join(tmpdir(), "intercom-inspect-"))
    try {
      const env = { MINIMAL_AGENT_HOME: home }
      const deps = {
        env,
        thresholds: resolveThresholds(env),
        now: () => Date.parse("2026-01-01T00:00:05.000Z"),
        host: "h",
        pidAlive: () => true,
      } as unknown as ServiceDeps
      const bundle = await inspectPeer(deps, rec, new Set(["transcript"] as const), {
        window: async () => win,
      })
      expect(bundle.notes).toBeUndefined()
      expect(bundle.transcript).toEqual([
        "#0 user 10:11:12: hello world",
        '#1 assistant: [thinking] hmm [tool_use Read] {"a":1}',
      ])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
