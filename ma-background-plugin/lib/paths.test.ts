import { describe, expect, test } from "bun:test"

import { defaultSessionsDir, indexPath, jobsDir, logPath, statusPath } from "./paths.ts"

const SID = "abc-123"

describe("defaultSessionsDir", () => {
  test("honors MINIMAL_AGENT_HOME", () => {
    expect(defaultSessionsDir({ MINIMAL_AGENT_HOME: "/custom/home" } as NodeJS.ProcessEnv)).toBe(
      "/custom/home/sessions",
    )
  })
  test("falls back to ~/.minimal-agent/sessions", () => {
    const dir = defaultSessionsDir({} as NodeJS.ProcessEnv)
    expect(dir.endsWith("/.minimal-agent/sessions")).toBe(true)
  })
  test("blank MINIMAL_AGENT_HOME falls back to home", () => {
    const dir = defaultSessionsDir({ MINIMAL_AGENT_HOME: "  " } as NodeJS.ProcessEnv)
    expect(dir.endsWith("/.minimal-agent/sessions")).toBe(true)
  })
})

describe("path builders", () => {
  const sessions = "/s"
  test("indexPath", () => {
    expect(indexPath(sessions, SID)).toBe(`/s/${SID}.bgjobs.jsonl`)
  })
  test("jobsDir", () => {
    expect(jobsDir(sessions, SID)).toBe(`/s/${SID}.bgjobs`)
  })
  test("logPath nests under jobsDir", () => {
    expect(logPath(sessions, SID, "j2")).toBe(`/s/${SID}.bgjobs/j2.log`)
  })
  test("statusPath nests under jobsDir", () => {
    expect(statusPath(sessions, SID, "j2")).toBe(`/s/${SID}.bgjobs/j2.status.json`)
  })
})
