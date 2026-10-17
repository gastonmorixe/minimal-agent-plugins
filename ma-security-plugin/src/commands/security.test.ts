import { expect, test } from "bun:test"

import { resolvePolicy } from "../config/resolve.ts"
import type { CommandContext } from "../host-types.ts"

import securityCommand from "./security.ts"

const ctx = (argv = "") => ({ argv }) as CommandContext

test("command defaults to uninitialized", () => {
  expect(JSON.stringify(securityCommand(ctx()))).toContain("uninitialized")
})

test("rules command lists known ids and resolved statuses", () => {
  const result = securityCommand(ctx("rules"), () => ({ policy: resolvePolicy({}) }))
  expect(result.kind).toBe("notice")
  expect(JSON.stringify(result)).toContain("secret.openai.api-key: on")
})

test("command does not echo unknown argv or provider error", () => {
  expect(JSON.stringify(securityCommand(ctx("PRIVATE_SENTINEL")))).not.toContain("PRIVATE_SENTINEL")
  expect(
    JSON.stringify(
      securityCommand(ctx(), () => {
        throw new Error("PRIVATE_SENTINEL")
      }),
    ),
  ).not.toContain("PRIVATE_SENTINEL")
})
