import { describe, expect, test } from "bun:test"

import denyDangerousBash, { isDangerousRmRf } from "./deny_dangerous_bash.ts"

describe("policy-ref deny_dangerous_bash", () => {
  test("detects rm -rf /", () => {
    expect(isDangerousRmRf("rm -rf /")).toBe(true)
    expect(isDangerousRmRf("echo hi")).toBe(false)
  })

  test("halts Bash with dangerous command", () => {
    const r = denyDangerousBash({
      tool: "Bash",
      toolUseId: "t1",
      input: { command: "rm -rf /" },
      cwd: "/tmp",
    })
    expect("halt" in r && r.halt).toBe(true)
  })

  test("allows Edit unchanged", () => {
    const p = {
      tool: "Edit",
      toolUseId: "t1",
      input: { file_path: "a.ts" },
      cwd: "/tmp",
    }
    expect(denyDangerousBash(p)).toBe(p)
  })
})
