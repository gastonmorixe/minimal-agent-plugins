import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { readNewRecords } from "./jsonl-tail.ts"
import { saveAuth } from "./token-store.ts"
import { advanceCursor, readCursor, zeroCursor } from "./upload-cursor.ts"
import { type FlushDeps, flushSession } from "./uploader.ts"

function tmpHome(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cloud-c2-"))
  return {
    env: { MINIMAL_AGENT_HOME: dir },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const login = (env: NodeJS.ProcessEnv) =>
  saveAuth(
    { v: 1, accessToken: "BEARER-XYZ", obtainedAt: 1, baseUrl: "http://localhost:4000/api/auth" },
    env,
  )

// ---------------------------------------------------------------------------
// jsonl-tail
// ---------------------------------------------------------------------------

describe("readNewRecords", () => {
  const three = '{"kind":"meta","sid":"s"}\n{"kind":"user"}\n{"kind":"assistant"}\n'

  it("reads all records from line 0 with -1 cursor", () => {
    const r = readNewRecords(three, -1)
    expect(r.records.map((x) => x.clientLine)).toEqual([0, 1, 2])
    expect(r.lastCompleteLine).toBe(2)
    expect(r.heldTornLine).toBe(false)
  })

  it("reads only records after the cursor", () => {
    const r = readNewRecords(three, 0)
    expect(r.records.map((x) => x.clientLine)).toEqual([1, 2])
  })

  it("holds back a torn final line (no trailing newline, unparseable)", () => {
    const torn = '{"kind":"meta"}\n{"kind":"user"}\n{"kind":"ass' // partial last line
    const r = readNewRecords(torn, -1)
    expect(r.records.map((x) => x.clientLine)).toEqual([0, 1]) // line 2 held
    expect(r.heldTornLine).toBe(true)
    expect(r.lastCompleteLine).toBe(1)
  })

  it("a complete final line WITH trailing newline is not torn", () => {
    const r = readNewRecords('{"a":1}\n', -1)
    expect(r.records).toHaveLength(1)
    expect(r.heldTornLine).toBe(false)
  })

  it("empty file ⇒ nothing", () => {
    expect(readNewRecords("", -1).records).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// upload-cursor
// ---------------------------------------------------------------------------

describe("upload-cursor", () => {
  it("zero cursor when absent; advance persists + is monotonic", () => {
    const h = tmpHome()
    try {
      expect(readCursor("sid-1", h.env).acceptedThroughClientLine).toBe(-1)
      advanceCursor("sid-1", 5, 12, h.env)
      expect(readCursor("sid-1", h.env).acceptedThroughClientLine).toBe(5)
      // a lower value never moves it backward
      advanceCursor("sid-1", 3, 9, h.env)
      expect(readCursor("sid-1", h.env).acceptedThroughClientLine).toBe(5)
    } finally {
      h.cleanup()
    }
  })

  it("rejects an unsafe sid (path traversal)", () => {
    expect(zeroCursor("../x").acceptedThroughClientLine).toBe(-1)
    advanceCursor("../x", 9, 9, { MINIMAL_AGENT_HOME: "/tmp/nope" })
    // never wrote (unsafe sid); reading returns zero
    expect(readCursor("../x", { MINIMAL_AGENT_HOME: "/tmp/nope" }).acceptedThroughClientLine).toBe(
      -1,
    )
  })
})

// ---------------------------------------------------------------------------
// flushSession
// ---------------------------------------------------------------------------

const SID = "sess-abc"
const THREE_RECORDS = '{"kind":"meta","sid":"sess-abc"}\n{"kind":"user"}\n{"kind":"assistant"}\n'

function deps(
  over: Partial<FlushDeps> & Pick<FlushDeps, "fetch">,
  env: NodeJS.ProcessEnv,
): FlushDeps {
  return {
    graphqlUrl: "http://localhost:4000/graphql",
    readSessionText: () => THREE_RECORDS,
    env,
    ...over,
  }
}

const ingestOk = (acceptedThroughClientLine: number, headSeq = 3) =>
  (async () =>
    new Response(
      JSON.stringify({ data: { ingestRecords: { acceptedThroughClientLine, headSeq } } }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )) as unknown as typeof fetch

describe("flushSession — gating", () => {
  it("skips when not logged in", async () => {
    const h = tmpHome()
    try {
      const out = await flushSession(SID, deps({ fetch: ingestOk(2) }, h.env))
      expect(out).toEqual({ ok: true, status: "skipped", reason: "not logged in" })
    } finally {
      h.cleanup()
    }
  })

  it("skips when there's no local session file", async () => {
    const h = tmpHome()
    try {
      login(h.env)
      const out = await flushSession(
        SID,
        deps({ fetch: ingestOk(2), readSessionText: () => null }, h.env),
      )
      expect(out.ok && out.status).toBe("skipped")
    } finally {
      h.cleanup()
    }
  })
})

describe("flushSession — upload + resume", () => {
  it("uploads new records, sends fromClientLine=0, advances the cursor", async () => {
    const h = tmpHome()
    try {
      login(h.env)
      let sentVars: { sid: string; fromClientLine: number; records: unknown[] } | undefined
      const fetchSpy = (async (_url: string, init?: RequestInit) => {
        sentVars = JSON.parse(String(init?.body)).variables
        return new Response(
          JSON.stringify({ data: { ingestRecords: { acceptedThroughClientLine: 2, headSeq: 3 } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }) as unknown as typeof fetch

      const out = await flushSession(SID, deps({ fetch: fetchSpy }, h.env))
      expect(out.ok && out.status).toBe("uploaded")
      if (out.ok && out.status === "uploaded") {
        expect(out.sent).toBe(3)
        expect(out.acceptedThroughClientLine).toBe(2)
      }
      expect(sentVars?.fromClientLine).toBe(0)
      expect(sentVars?.records).toHaveLength(3)
      // cursor advanced ⇒ a second flush has nothing new
      const out2 = await flushSession(SID, deps({ fetch: ingestOk(2) }, h.env))
      expect(out2.ok && out2.status).toBe("nothing-new")
    } finally {
      h.cleanup()
    }
  })

  it("resumes from the persisted cursor (only ships records after it)", async () => {
    const h = tmpHome()
    try {
      login(h.env)
      advanceCursor(SID, 0, 1, h.env) // pretend line 0 already accepted
      let sentVars: { fromClientLine: number; records: unknown[] } | undefined
      const fetchSpy = (async (_url: string, init?: RequestInit) => {
        sentVars = JSON.parse(String(init?.body)).variables
        return new Response(
          JSON.stringify({ data: { ingestRecords: { acceptedThroughClientLine: 2, headSeq: 3 } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }) as unknown as typeof fetch
      await flushSession(SID, deps({ fetch: fetchSpy }, h.env))
      expect(sentVars?.fromClientLine).toBe(1) // resumed after line 0
      expect(sentVars?.records).toHaveLength(2) // lines 1,2 only
    } finally {
      h.cleanup()
    }
  })

  it("never throws on a network failure — returns ok:false, cursor unchanged", async () => {
    const h = tmpHome()
    try {
      login(h.env)
      const boom = (async () => {
        throw new Error("ECONNREFUSED")
      }) as unknown as typeof fetch
      const out = await flushSession(SID, deps({ fetch: boom }, h.env))
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toContain("ECONNREFUSED")
      // cursor NOT advanced ⇒ will retry the same range next flush
      expect(readCursor(SID, h.env).acceptedThroughClientLine).toBe(-1)
    } finally {
      h.cleanup()
    }
  })

  it("surfaces a GraphQL error as ok:false", async () => {
    const h = tmpHome()
    try {
      login(h.env)
      const err = (async () =>
        new Response(JSON.stringify({ errors: [{ message: "unauthorized" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch
      const out = await flushSession(SID, deps({ fetch: err }, h.env))
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toContain("unauthorized")
    } finally {
      h.cleanup()
    }
  })
})
