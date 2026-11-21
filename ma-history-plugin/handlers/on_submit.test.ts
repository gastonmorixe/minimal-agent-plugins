/**
 * Tests for the `editor.submitted` handler. History holds only what the user
 * typed: the manifest subscribes to `editor.submitted` and NOT to the queue
 * event `prompt.submitted` (injected, expanded, recovery prompts).
 */

import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"

import { AGENT_HOME_ENV } from "@minimal-agent/core/plugin-api/utils/agent-paths"

import type { EditorSubmittedPayload, EventHandlerContext } from "../lib/host-types.ts"
import { _resetSessionCache, recallFor } from "../lib/session.ts"
import {
  _clearAll,
  HISTORY_DISABLE_ENV,
  HISTORY_NAMESPACE_ENV,
  loadEntries,
  projectHistoryPath,
} from "../lib/store.ts"
import manifest from "../manifest.json"

import handler from "./on_submit.ts"

const NS = `history-on-submit-test-${process.pid}`
const TEST_HOME = join(tmpdir(), `minimal-agent-history-on-submit-${process.pid}`)
const CWD = "/test/on-submit-cwd"
const saved = {
  home: process.env.HOME,
  maHome: process.env[AGENT_HOME_ENV],
  ns: process.env[HISTORY_NAMESPACE_ENV],
  off: process.env[HISTORY_DISABLE_ENV],
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeAll(() => {
  process.env.HOME = TEST_HOME
  process.env[HISTORY_NAMESPACE_ENV] = NS
  delete process.env[AGENT_HOME_ENV]
  delete process.env[HISTORY_DISABLE_ENV]
})
afterAll(() => {
  _clearAll(process.env, CWD)
  restore("HOME", saved.home)
  restore(AGENT_HOME_ENV, saved.maHome)
  restore(HISTORY_NAMESPACE_ENV, saved.ns)
  restore(HISTORY_DISABLE_ENV, saved.off)
  rmSync(TEST_HOME, { recursive: true, force: true })
})
beforeEach(() => {
  delete process.env[HISTORY_DISABLE_ENV]
  _clearAll(process.env, CWD)
  _resetSessionCache()
})

function ctx(payload: unknown, warns: string[] = []): EventHandlerContext<EditorSubmittedPayload> {
  return {
    payload: payload as EditorSubmittedPayload,
    cwd: CWD,
    log: {
      info: () => {},
      warn: (_s, m) => warns.push(m),
      error: () => {},
      debug: () => {},
    },
  }
}

function typed(text: string, submittedAt = "2026-11-20T12:00:00.000Z"): EditorSubmittedPayload {
  return { text, cwd: CWD, sid: "sid-1", submittedAt }
}

function texts(): string[] {
  return loadEntries(projectHistoryPath(CWD)).map((e) => e.text)
}

describe("history manifest", () => {
  it("subscribes to editor.submitted only (never the queue event prompt.submitted)", () => {
    const events = manifest.headless.events
    expect(events.map((e) => e.on)).toEqual(["editor.submitted"])
    expect(manifest.permissions).toContain("hooks:editor.submitted")
    expect(manifest.permissions).not.toContain("hooks:prompt.submitted")
  })
})

describe("on_submit (editor.submitted)", () => {
  it("records the typed line on disk and pushes it to the recall", async () => {
    await handler(ctx(typed("hello world")))
    const entries = loadEntries(projectHistoryPath(CWD))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      text: "hello world",
      cwd: CWD,
      sid: "sid-1",
      exit: "submitted",
      ts: "2026-11-20T12:00:00.000Z",
    })
    expect(recallFor(CWD).up("")).toMatchObject({ halt: true, buffer: "hello world" })
  })

  it("records a typed slash-command line as typed", async () => {
    await handler(ctx(typed("/model claude-x")))
    expect(texts()).toEqual(["/model claude-x"])
  })

  it("ignores a blank or whitespace-only line", async () => {
    await handler(ctx(typed("   \n  ")))
    expect(texts()).toEqual([])
    expect(recallFor(CWD).size()).toBe(0)
  })

  it("keeps the recall dedupe of adjacent identical lines", async () => {
    await handler(ctx(typed("same")))
    await handler(ctx(typed("same")))
    expect(recallFor(CWD).size()).toBe(1)
  })

  it("uses now when submittedAt is not a valid date", async () => {
    await handler(ctx(typed("x", "not-a-date")))
    const ts = loadEntries(projectHistoryPath(CWD))[0]?.ts ?? ""
    expect(Number.isNaN(Date.parse(ts))).toBe(false)
  })

  it("rejects a prompt.submitted-shaped payload (no submittedAt): an inject never lands", async () => {
    const warns: string[] = []
    const queued = {
      text: "intercom: 1 message(s) from A1",
      cwd: CWD,
      sid: null,
      exit: "submitted",
      queuePos: 0,
      source: "inject",
    }
    await handler(ctx(queued, warns))
    expect(texts()).toEqual([])
    expect(warns).toHaveLength(1)
  })

  it("MINIMAL_AGENT_NO_HISTORY=1 records nothing", async () => {
    process.env[HISTORY_DISABLE_ENV] = "1"
    await handler(ctx(typed("blocked")))
    delete process.env[HISTORY_DISABLE_ENV]
    let raw = ""
    try {
      raw = readFileSync(projectHistoryPath(CWD), "utf8")
    } catch {
      raw = ""
    }
    expect(raw).toBe("")
  })
})
