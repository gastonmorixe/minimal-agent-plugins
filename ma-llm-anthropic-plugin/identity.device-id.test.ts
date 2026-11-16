/**
 * Our own device id (`getOwnDeviceId`): atomic first-use creation, private
 * modes, and the test guard that keeps the real agent home untouched.
 *
 * @module llm/providers/anthropic/identity.device-id.test
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeEach, describe, expect, it } from "bun:test"

import {
  _resetIdentityForTest,
  accountUuidFor,
  buildOAuthMetadata,
  getOwnDeviceId,
  ownDeviceIdPath,
  rememberAccountUuid,
  rememberCredentialAccount,
} from "./identity.ts"
import { readAnthropicOAuthAuth } from "./oauth-login.ts"

const tmp = mkdtempSync(join(tmpdir(), "ma-anthropic-device-id-"))

beforeEach(() => _resetIdentityForTest())
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe("getOwnDeviceId", () => {
  it("the test preload points the agent home at a temp dir", () => {
    const realHome = join(process.env.HOME ?? "", ".minimal-agent")
    expect(ownDeviceIdPath().startsWith(realHome)).toBe(false)
    expect(ownDeviceIdPath().startsWith(tmpdir()) || ownDeviceIdPath().includes("/tmp")).toBe(true)
  })

  it("stays in memory under BUN_ENV=test even without NODE_ENV", () => {
    const saved = process.env.NODE_ENV
    delete process.env.NODE_ENV
    const savedBun = process.env.BUN_ENV
    process.env.BUN_ENV = "test"
    try {
      const id = getOwnDeviceId()
      expect(id).toMatch(/^[0-9a-f]{64}$/)
      expect(() => statSync(ownDeviceIdPath())).toThrow()
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = saved
      if (savedBun === undefined) delete process.env.BUN_ENV
      else process.env.BUN_ENV = savedBun
    }
  })

  it("creates the file 0600 in a 0700 dir and reuses it", () => {
    const path = join(tmp, "fresh", "anthropic", "device.json")
    const id = getOwnDeviceId(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(tmp, "fresh", "anthropic")).mode & 0o777).toBe(0o700)
    _resetIdentityForTest()
    expect(getOwnDeviceId(path)).toBe(id)
  })

  it("an existing file wins (EEXIST path adopts the winner's id)", () => {
    const path = join(tmp, "existing", "device.json")
    getOwnDeviceId(path)
    const winner = "b".repeat(64)
    writeFileSync(path, JSON.stringify({ deviceId: winner }))
    _resetIdentityForTest()
    expect(getOwnDeviceId(path)).toBe(winner)
  })

  it("concurrent first use from fresh state: every process gets the same id", async () => {
    const path = join(tmp, "race", "device.json")
    const script = `import { getOwnDeviceId } from ${JSON.stringify(join(import.meta.dir, "identity.ts"))}
process.stdout.write(getOwnDeviceId(${JSON.stringify(path)}))`
    const procs = Array.from({ length: 6 }, () =>
      Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" }),
    )
    const ids = await Promise.all(procs.map((p) => new Response(p.stdout).text()))
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(ids).size).toBe(1)
    expect(JSON.parse(readFileSync(path, "utf8")).deviceId).toBe(ids[0])
  })
})

describe("account uuid for metadata.user_id", () => {
  const ACCOUNT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
  const user = (token?: string) =>
    JSON.parse(buildOAuthMetadata("s", join(tmp, "acct.json"), token).user_id)

  it("is seeded from the stored credential when core reads it", () => {
    const auth = readAnthropicOAuthAuth({ accessToken: "tok-1", accountUuid: ACCOUNT })
    expect(auth).toEqual({ kind: "oauth", token: "tok-1" })
    expect(accountUuidFor("tok-1")).toBe(ACCOUNT)
    expect(user("tok-1").account_uuid).toBe(ACCOUNT)
    // Another credential's token does not inherit it.
    expect(user("tok-2").account_uuid).toBe("")
  })

  it("the probe-learned uuid overrides the credential seed", () => {
    rememberCredentialAccount("tok-1", ACCOUNT)
    rememberAccountUuid("ba0ad20f-0000-4000-8000-cf4c4732fd3b")
    expect(user("tok-1").account_uuid).toBe("ba0ad20f-0000-4000-8000-cf4c4732fd3b")
  })

  it("a credential without accountUuid seeds nothing", () => {
    readAnthropicOAuthAuth({ accessToken: "tok-3" })
    expect(accountUuidFor("tok-3")).toBeUndefined()
  })
})
