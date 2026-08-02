import { describe, expect, test } from "bun:test"

import redactSecretsWillSend from "./redact_secrets_will_send.ts"

describe("policy-ref redact_secrets_will_send", () => {
  test("redacts sk- tokens in user text", () => {
    const out = redactSecretsWillSend({
      messages: [{ role: "user", content: "key sk-abcdefghijklmnop here" }],
      system: "sys",
      model: "m",
    })
    expect(JSON.stringify(out.messages)).toContain("sk-[REDACTED]")
    expect(JSON.stringify(out.messages)).not.toContain("sk-abcdefghijklmnop")
  })
})
