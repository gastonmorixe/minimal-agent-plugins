import { describe, expect, it } from "bun:test"

import {
  applyGrokAccountProfile,
  identityFromUserinfoAndSession,
  isActiveGrokPlanStatus,
  pickGrokSubscription,
  planFieldsFromSubscriptions,
  preserveGrokAccountProfileSecrets,
} from "./account-profile.ts"
import type { NetworkClient } from "./lib/net-types.ts"
import type { AuthSecretBag } from "./lib/provider-plugin.ts"
import {
  finalizeGrokOAuthCredential,
  inspectGrokOAuthCredential,
  refreshGrokOAuthCredential,
} from "./oauth-login.ts"

describe("grok account profile", () => {
  it("detects active subscription statuses", () => {
    expect(isActiveGrokPlanStatus("SUBSCRIPTION_STATUS_ACTIVE")).toBe(true)
    expect(isActiveGrokPlanStatus("ACTIVE")).toBe(true)
    expect(isActiveGrokPlanStatus("SUBSCRIPTION_STATUS_INACTIVE")).toBe(false)
    expect(isActiveGrokPlanStatus("none")).toBe(false)
  })

  it("prefers ACTIVE subscription rows over inactive ones", () => {
    const picked = pickGrokSubscription({
      summary: [
        {
          provider: "stripe",
          tier: "SUBSCRIPTION_TIER_GROK_PRO",
          status: "SUBSCRIPTION_STATUS_INACTIVE",
        },
        {
          provider: "x",
          tier: "SUBSCRIPTION_TIER_X_PREMIUM",
          status: "SUBSCRIPTION_STATUS_ACTIVE",
        },
      ],
    })
    expect(picked?.tier).toBe("SUBSCRIPTION_TIER_X_PREMIUM")
    expect(picked?.provider).toBe("x")
  })

  it("reads either summary or subscriptions arrays", () => {
    const fromSubs = pickGrokSubscription({
      subscriptions: [
        {
          provider: "braintree",
          tier: "SUBSCRIPTION_TIER_GROK_PRO",
          status: "SUBSCRIPTION_STATUS_ACTIVE",
        },
      ],
    })
    expect(fromSubs?.provider).toBe("braintree")
  })

  it("maps empty subscriptions to planStatus none; failed fetch stays empty", () => {
    expect(planFieldsFromSubscriptions({ summary: [] })).toEqual({ planStatus: "none" })
    expect(planFieldsFromSubscriptions(null)).toEqual({})
    expect(planFieldsFromSubscriptions(undefined)).toEqual({})
  })

  it("merges userinfo + session identity fields", () => {
    const profile = identityFromUserinfoAndSession(
      {
        email: "gaston@gastonmorixe.com",
        name: "Gaston M",
        given_name: "Gaston",
        family_name: "M",
        email_verified: true,
        picture: "pic.webp",
      },
      {
        email: "gaston@gastonmorixe.com",
        xUserId: "764099755681189892",
        givenName: "Gaston",
        familyName: "M",
      },
    )
    expect(profile).toEqual({
      emailAddress: "gaston@gastonmorixe.com",
      displayName: "Gaston M",
      givenName: "Gaston",
      familyName: "M",
      emailVerified: true,
      picture: "pic.webp",
      xUserId: "764099755681189892",
    })
  })

  it("applies profile onto secrets and preserves priors when missing", () => {
    const secrets: AuthSecretBag = { accessToken: "at" }
    applyGrokAccountProfile(secrets, {
      emailAddress: "a@b.com",
      plan: "SUBSCRIPTION_TIER_X_PREMIUM",
      planStatus: "SUBSCRIPTION_STATUS_ACTIVE",
      planProvider: "x",
    })
    expect(secrets.emailAddress).toBe("a@b.com")
    expect(secrets.plan).toBe("SUBSCRIPTION_TIER_X_PREMIUM")

    const refreshed: AuthSecretBag = { accessToken: "at2" }
    preserveGrokAccountProfileSecrets(refreshed, secrets)
    expect(refreshed.emailAddress).toBe("a@b.com")
    expect(refreshed.planStatus).toBe("SUBSCRIPTION_STATUS_ACTIVE")

    applyGrokAccountProfile(refreshed, {
      emailAddress: "new@b.com",
      planStatus: "none",
    })
    expect(refreshed.emailAddress).toBe("new@b.com")
    expect(refreshed.planStatus).toBe("none")
    expect(refreshed.plan).toBeUndefined()
    expect(refreshed.planProvider).toBeUndefined()
  })

  it("picks newest inactive tier when none are ACTIVE", () => {
    const picked = pickGrokSubscription({
      summary: [
        {
          provider: "stripe",
          tier: "SUBSCRIPTION_TIER_GROK_PRO",
          status: "SUBSCRIPTION_STATUS_INACTIVE",
          billingPeriodEnd: "2026-07-22T05:21:34Z",
        },
        {
          provider: "stripe",
          tier: "SUBSCRIPTION_TIER_GROK_PRO",
          status: "SUBSCRIPTION_STATUS_INACTIVE",
          billingPeriodEnd: "2026-08-22T05:21:34Z",
        },
      ],
    })
    expect(picked?.billingPeriodEnd).toBe("2026-08-22T05:21:34Z")
  })

  it("enriches OAuth secrets with email/plan on finalize + refresh", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        sub: "user-uuid-1",
        principal_id: "user-uuid-1",
        team_id: "team-uuid-1",
        tier: 3,
        scope: "openid email",
      }),
    ).toString("base64url")
    const accessToken = `hdr.${payload}.sig`

    const urls: string[] = []
    const networkClient = {
      async request(req: { url: string; method?: string; body?: string }) {
        urls.push(req.url)
        if (req.url.includes("/oauth2/token")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              access_token: accessToken,
              refresh_token: "rt-rotated",
              expires_in: 3600,
              scope: "openid email",
            }),
            text: async () => "",
          }
        }
        if (req.url.includes("/oauth2/userinfo")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              email: "gaston@example.com",
              name: "Gaston M",
              given_name: "Gaston",
              family_name: "M",
              email_verified: true,
              sub: "user-uuid-1",
            }),
            text: async () => "",
          }
        }
        if (req.url.includes("/api/auth/session")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              userId: "user-uuid-1",
              email: "gaston@example.com",
              xUserId: "x-123",
              givenName: "Gaston",
              familyName: "M",
            }),
            text: async () => "",
          }
        }
        if (req.url.includes("/rest/subscriptions")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              activeCount: 1,
              summary: [
                {
                  provider: "x",
                  tier: "SUBSCRIPTION_TIER_X_PREMIUM",
                  status: "SUBSCRIPTION_STATUS_ACTIVE",
                },
              ],
            }),
            text: async () => "",
          }
        }
        return {
          ok: false,
          status: 404,
          headers: new Headers(),
          json: async () => ({}),
          text: async () => "",
        }
      },
    } as unknown as NetworkClient

    const finalized = await finalizeGrokOAuthCredential(
      {
        access_token: accessToken,
        refresh_token: "rt-1",
        expires_in: 3600,
        scope: "openid email",
      },
      { networkClient },
    )
    expect(finalized.credential.secrets.emailAddress).toBe("gaston@example.com")
    expect(finalized.credential.secrets.displayName).toBe("Gaston M")
    expect(finalized.credential.secrets.plan).toBe("SUBSCRIPTION_TIER_X_PREMIUM")
    expect(finalized.credential.secrets.planStatus).toBe("SUBSCRIPTION_STATUS_ACTIVE")
    expect(finalized.credential.secrets.planProvider).toBe("x")
    expect(finalized.credential.secrets.xUserId).toBe("x-123")
    expect(finalized.credential.secrets.jwtTier).toBe(3)
    expect(finalized.result.account?.emailAddress).toBe("gaston@example.com")

    const inspected = inspectGrokOAuthCredential(finalized.credential.secrets)
    expect(inspected.accountId).toBe("gaston@example.com")
    expect(inspected.label).toContain("SUBSCRIPTION_TIER_X_PREMIUM")

    const refreshed = await refreshGrokOAuthCredential(finalized.credential.secrets, {
      networkClient,
    })
    expect(refreshed.credential.secrets.refreshToken).toBe("rt-rotated")
    expect(refreshed.credential.secrets.emailAddress).toBe("gaston@example.com")
    expect(refreshed.credential.secrets.planStatus).toBe("SUBSCRIPTION_STATUS_ACTIVE")
    expect(urls.some((u) => u.includes("/oauth2/token"))).toBe(true)
  })

  it("preserves prior email/plan when enrichment endpoints fail on refresh", async () => {
    const payload = Buffer.from(JSON.stringify({ sub: "u2", team_id: "t2" })).toString("base64url")
    const accessToken = `hdr.${payload}.sig`
    const prior: Record<string, unknown> = {
      tokenType: "oauth",
      accessToken: "old",
      refreshToken: "rt-keep",
      expiresAt: Date.now() + 60_000,
      emailAddress: "old@example.com",
      displayName: "Old Name",
      plan: "SUBSCRIPTION_TIER_GROK_PRO",
      planStatus: "SUBSCRIPTION_STATUS_INACTIVE",
      userId: "u2",
    }

    const networkClient = {
      async request(req: { url: string }) {
        if (req.url.includes("/oauth2/token")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              access_token: accessToken,
              // omit refresh_token → plugin must keep prior
              expires_in: 1800,
            }),
            text: async () => "",
          }
        }
        return {
          ok: false,
          status: 503,
          headers: new Headers(),
          json: async () => ({}),
          text: async () => "down",
        }
      },
    } as unknown as NetworkClient

    const refreshed = await refreshGrokOAuthCredential(prior as never, { networkClient })
    expect(refreshed.credential.secrets.accessToken).toBe(accessToken)
    expect(refreshed.credential.secrets.refreshToken).toBe("rt-keep")
    expect(refreshed.credential.secrets.emailAddress).toBe("old@example.com")
    expect(refreshed.credential.secrets.plan).toBe("SUBSCRIPTION_TIER_GROK_PRO")
    expect(refreshed.credential.secrets.planStatus).toBe("SUBSCRIPTION_STATUS_INACTIVE")
  })
})
