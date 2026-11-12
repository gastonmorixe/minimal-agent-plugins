import { describe, expect, it } from "bun:test"

import { errorText } from "./error-text.ts"

const typed = (kind: string, fields: Record<string, unknown> = {}) => ({
  message: "",
  kind,
  toJSON: () => ({ kind, fields }),
})

describe("errorText", () => {
  it("returns a plain Error message", () => {
    expect(errorText(new Error("boom"))).toBe("boom")
  })
  it("returns a string as is", () => {
    expect(errorText("oops")).toBe("oops")
  })
  it("returns a message of a plain object", () => {
    expect(errorText({ message: "x" })).toBe("x")
  })
  it("prefers a non-empty message over the kind", () => {
    expect(errorText({ ...typed("NoProviderCredentialsError"), message: "own" })).toBe("own")
  })
  it("renders NoProviderSelectedError with a provider list", () => {
    expect(
      errorText(
        typed("NoProviderSelectedError", {
          modelId: "m",
          credentialedProviders: [{ providerId: "p", labels: ["a", "b"], exampleModels: ["x"] }],
        }),
      ),
    ).toBe(
      'no provider selected for model "m". Logged in: p (a, b) \u2014 e.g. "x". ' +
        'Set "model" and "provider" in ~/.minimal-agent/config.jsonc or pass --provider <id> --model <id>.',
    )
  })
  it("renders NoProviderCredentialsError with no providers", () => {
    expect(errorText(typed("NoProviderCredentialsError", { providerId: "p", modelId: "m" }))).toBe(
      'no credentials for provider "p" (model "m"). Run minimal-agent provider p login. ' +
        "No provider credentials found. Run `minimal-agent provider <id> login` " +
        "(e.g. `minimal-agent provider example-provider login`).",
    )
  })
  it("renders the other known kinds", () => {
    expect(
      errorText(typed("GenericEndpointAuthError", { authType: "bearer", missing: "key" })),
    ).toBe("generic-endpoint auth-type bearer requires --key")
    expect(errorText(typed("UnhandledAuthTypeError", { authType: "zz" }))).toBe(
      "unhandled generic-endpoint auth-type: zz",
    )
    expect(errorText(typed("SignInTimeoutError"))).toBe("Sign-in timed out. Run login again.")
    expect(errorText(typed("InvalidAuthorizationCodeError"))).toBe(
      "Authentication failed: invalid authorization code",
    )
    expect(errorText(typed("TokenExchangeError", { status: 400, body: "bad" }))).toBe(
      "Token exchange failed (400): bad",
    )
    expect(errorText(typed("NoOAuthLoginProviderError"))).toBe(
      "No OAuth login provider is registered.",
    )
  })
  it("falls back to the kind name for an unknown kind", () => {
    expect(errorText(typed("SomethingNewError"))).toBe("SomethingNewError")
  })
  it("returns empty for an empty-message error with no kind", () => {
    expect(errorText(new Error(""))).toBe("")
  })
})
