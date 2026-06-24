import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { type EmitFn, PendingInjector } from "./pending-inject.ts"
import { saveAuth } from "./token-store.ts"
import { type FlushDeps, flushSession } from "./uploader.ts"

describe("PendingInjector", () => {
  it("inject emits prompt.inject with the content + a cloud:pending source", () => {
    const emitted: { channel: string; payload: unknown }[] = []
    const emit: EmitFn = (channel, payload) => emitted.push({ channel, payload })
    const inj = new PendingInjector(emit)
    inj.inject({ pendingId: "P1", content: "do the thing" })
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.channel).toBe("prompt.inject")
    expect((emitted[0]?.payload as { text: string }).text).toBe("do the thing")
    expect((emitted[0]?.payload as { source: string }).source).toContain("P1")
    expect(inj.pending).toBe(1)
  })

  it("blank content is not injected", () => {
    const emitted: unknown[] = []
    const inj = new PendingInjector(() => emitted.push(1))
    inj.inject({ pendingId: "P1", content: "   " })
    expect(emitted).toHaveLength(0)
    expect(inj.pending).toBe(0)
  })

  it("stampPendingId tags the matching user record once (FIFO), consuming the queue entry", () => {
    const inj = new PendingInjector(() => {})
    inj.inject({ pendingId: "P1", content: "hello" })
    // a non-user record passes through untouched
    const meta = inj.stampPendingId({ kind: "meta", content: "x" })
    expect("pendingId" in meta).toBe(false)
    // the matching user record gets stamped
    const user = inj.stampPendingId({ kind: "user", content: "hello" })
    expect(user.pendingId).toBe("P1")
    expect(inj.pending).toBe(0)
    // a second identical user record is NOT stamped (queue consumed)
    const user2 = inj.stampPendingId({ kind: "user", content: "hello" })
    expect("pendingId" in user2).toBe(false)
  })

  it("a non-matching user record is left alone", () => {
    const inj = new PendingInjector(() => {})
    inj.inject({ pendingId: "P1", content: "expected" })
    const other = inj.stampPendingId({ kind: "user", content: "something else" })
    expect("pendingId" in other).toBe(false)
    expect(inj.pending).toBe(1) // still waiting for its match
  })

  it("two distinct prompts resolve in order", () => {
    const inj = new PendingInjector(() => {})
    inj.inject({ pendingId: "P1", content: "first" })
    inj.inject({ pendingId: "P2", content: "second" })
    expect(inj.stampPendingId({ kind: "user", content: "second" }).pendingId).toBe("P2")
    expect(inj.stampPendingId({ kind: "user", content: "first" }).pendingId).toBe("P1")
    expect(inj.pending).toBe(0)
  })
})

describe("uploader stampRecord integration", () => {
  it("the injector's stamp tags the uploaded user record with pendingId", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cloud-stamp-"))
    const env = { MINIMAL_AGENT_HOME: dir } as NodeJS.ProcessEnv
    try {
      saveAuth(
        { v: 1, accessToken: "B", obtainedAt: 1, baseUrl: "http://localhost:4000/api/auth" },
        env,
      )
      const inj = new PendingInjector(() => {})
      inj.inject({ pendingId: "P9", content: "run me" })

      const jsonl =
        '{"kind":"meta","sid":"s"}\n{"kind":"user","content":"run me"}\n{"kind":"assistant","content":[{"type":"text","text":"ran"}]}\n'
      let sentRecords: Record<string, unknown>[] | undefined
      const fetchSpy = (async (_url: string, initArg?: RequestInit) => {
        sentRecords = JSON.parse(String(initArg?.body)).variables.records
        return new Response(
          JSON.stringify({ data: { ingestRecords: { acceptedThroughClientLine: 2, headSeq: 3 } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }) as unknown as typeof fetch

      const deps: FlushDeps = {
        graphqlUrl: "http://localhost:4000/graphql",
        readSessionText: () => jsonl,
        fetch: fetchSpy,
        env,
        stampRecord: (r) => inj.stampPendingId(r),
      }
      const out = await flushSession("s", deps)
      expect(out.ok && out.status).toBe("uploaded")
      // the user record now carries pendingId=P9; meta + assistant do not
      const user = sentRecords?.find((r) => r.kind === "user")
      expect(user?.pendingId).toBe("P9")
      expect(sentRecords?.find((r) => r.kind === "meta")?.pendingId).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
