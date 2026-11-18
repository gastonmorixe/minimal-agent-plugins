/**
 * The carry fingerprint ignores the internal block keys `sideband` and
 * `outcome` (leader decision S3). For content with no metadata key, the hash
 * stays equal to the old formula, so carry files on disk stay valid.
 */

import { describe, expect, test } from "bun:test"

import type { CanonicalMessage } from "@minimal-agent/core/plugin-api/llm/canonical-messages"

import { fingerprintMessages } from "./conversation-carry.ts"

/** The formula before this change: the JSON of the whole content. */
function oldFingerprint(messages: readonly CanonicalMessage[]): string {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const msg of messages) {
    hasher.update(msg.role)
    hasher.update("\u0000")
    hasher.update(JSON.stringify(msg.content))
    hasher.update("\u0001")
  }
  return hasher.digest("hex")
}

const OUTCOME = { v: 1, bodyEnd: 2, annotations: [] }

function conversation(meta: boolean): CanonicalMessage[] {
  const extra = (value: Record<string, unknown>) => (meta ? value : {})
  return [
    {
      role: "user",
      content: [{ type: "text", text: "run it" }],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "t1",
          content: [{ type: "text", text: "a\nb" }],
          isError: false,
          ...extra({ sideband: { kind: "notice" }, outcome: OUTCOME }),
        },
        { type: "text", text: "note", ...extra({ sideband: { kind: "notice" } }) },
      ],
    },
  ] as CanonicalMessage[]
}

describe("fingerprintMessages and block metadata", () => {
  test("content with sideband and outcome hashes the same as without them", () => {
    expect(fingerprintMessages(conversation(true))).toBe(fingerprintMessages(conversation(false)))
  })

  test("content with no metadata hashes the same as the old formula", () => {
    const plain = conversation(false)
    expect(fingerprintMessages(plain)).toBe(oldFingerprint(plain))
  })

  test("a change in the visible content still changes the hash", () => {
    const other = conversation(false)
    other[0] = { role: "user", content: [{ type: "text", text: "run that" }] }
    expect(fingerprintMessages(other)).not.toBe(fingerprintMessages(conversation(false)))
  })
})
