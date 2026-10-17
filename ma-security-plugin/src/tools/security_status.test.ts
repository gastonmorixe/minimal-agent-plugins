import { expect, test } from "bun:test"

import { resolvePolicy } from "../config/resolve.ts"
import type { TUIContext } from "../host-types.ts"

import securityStatus from "./security_status.ts"

const ctx = {} as TUIContext

test("tool defaults to an uninitialized safe report", () => {
  const result = securityStatus(ctx)
  expect(JSON.parse(result.content).phase).toBe("uninitialized")
})

test("tool uses only an explicit provider, with no shared state", () => {
  const result = securityStatus(ctx, () => ({ policy: resolvePolicy({}) }))
  expect(JSON.parse(result.content).phase).toBe("resolved")
  expect(JSON.parse(securityStatus(ctx).content).phase).toBe("uninitialized")
})

test("tool never exposes a provider error", () => {
  const result = securityStatus(ctx, () => {
    throw new Error("PRIVATE_SENTINEL")
  })
  expect(result.is_error).toBe(true)
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL")
})
