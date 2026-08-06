/**
 * Meta Model API provider offline tests.
 *
 * @module llm/providers/meta/meta.test
 */

import { describe, expect, it } from "bun:test"

import {
  bootstrapMeta,
  metaAdapter,
  metaProviderPlugin,
  registerMetaAdHocModel,
} from "./adapter.ts"
import {
  buildMetaApiKeyCredential,
  META_API_KEY_AUTH,
  metaApiKeyAuth,
  readMetaApiKey,
} from "./auth.ts"
import type { NetworkClient } from "./lib/net-types.ts"
import type { RunContext } from "./lib/provider-auth.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { listMetaBuiltinModelIds, META_DEFAULT_MODEL_ID, registerMetaModels } from "./models.ts"
import {
  clearMetaRateLimits,
  fetchMetaSessionInfo,
  parseMetaQuotaWindows,
  setMetaRateLimits,
} from "./session-info.ts"
import { CHAT_COMPLETIONS_URL, META_OPENAI_BASE, MODELS_URL } from "./wire-constants.ts"

function fakeNetworkClient(status: number, body: string, headers?: Headers) {
  return {
    async request() {
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
        headers: headers ?? new Headers(),
      }
    },
  } as unknown as NetworkClient
}

async function drainCatch(
  gen: AsyncIterable<unknown>,
): Promise<(Error & { streamErrorType?: string }) | null> {
  try {
    for await (const _ of gen) {
      /* drain */
    }
    return null
  } catch (err) {
    return err as Error & { streamErrorType?: string }
  }
}

let reg = makeTestRegistry()
function setup() {
  reg = makeTestRegistry()
  bootstrapMeta({ models: reg.models, providers: reg.providers })
  return reg
}

describe("meta plugin shape", () => {
  it("exports plugin id and api-key auth (no oauth)", () => {
    expect(metaProviderPlugin.id).toBe("meta")
    expect(metaProviderPlugin.shortCode).toBe("meta")
    expect(metaProviderPlugin.apiKeyAuth?.serviceId).toBe(META_API_KEY_AUTH.serviceId)
    expect(metaProviderPlugin.oauthLogin).toBeUndefined()
    expect(metaProviderPlugin.listLiveModels).toBeDefined()
  })

  it("registers three Muse Spark models", () => {
    const r = makeTestRegistry()
    const ids = registerMetaModels(r.models)
    expect(ids).toHaveLength(3)
    expect(ids).toContain("muse-spark-1.2")
    expect(ids).toContain("muse-spark-1.1")
    expect(ids).toContain("muse-spark-1.2-contributor")
    expect(listMetaBuiltinModelIds()).toHaveLength(3)
    expect(META_DEFAULT_MODEL_ID).toBe("muse-spark-1.2")
  })

  it("bootstrap registers adapter + models", () => {
    const r = setup()
    expect(r.resolveProvider("meta").id).toBe("meta")
    expect(r.resolveModel("muse-spark-1.2").providerId).toBe("meta")
    expect(r.resolveModel("muse-spark-1.2").surfaceId).toBe("openai-chat-completions")
  })

  it("ad-hoc model registers bare Meta slug", () => {
    const r = setup()
    registerMetaAdHocModel("muse-spark-9.9")
    expect(r.resolveModel("muse-spark-9.9").id).toBe("muse-spark-9.9")
  })

  it("modelVersionToken strips muse-spark- prefix", () => {
    expect(metaProviderPlugin.modelVersionToken?.("muse-spark-1.2")).toBe("1.2")
    expect(metaProviderPlugin.modelVersionToken?.("muse-spark-1.2-contributor")).toBe(
      "1.2-contributor",
    )
    expect(metaProviderPlugin.modelVersionToken?.("other")).toBeUndefined()
  })

  it("recommends scout/balanced/deep from tags", () => {
    setup()
    const recs = metaAdapter.recommendSubagentModels?.() ?? []
    const byRole = Object.fromEntries(recs.map((r) => [r.role, r.modelId]))
    expect(byRole.scout).toBe("muse-spark-1.2-contributor")
    expect(byRole.balanced).toBe("muse-spark-1.1")
    expect(byRole.deep).toBe("muse-spark-1.2")
  })
})

describe("meta auth", () => {
  it("round-trips API key secrets", () => {
    const cred = buildMetaApiKeyCredential("LLM_test_key")
    expect(cred.serviceId).toBe("meta-api-key")
    expect(readMetaApiKey(cred.secrets)).toBe("LLM_test_key")
    expect(metaApiKeyAuth.inspectCredential?.(cred.secrets).usable).toBe(true)
  })
})

describe("meta wire constants", () => {
  it("points at api.meta.ai/v1", () => {
    expect(META_OPENAI_BASE).toBe("https://api.meta.ai/v1")
    expect(CHAT_COMPLETIONS_URL).toBe("https://api.meta.ai/v1/chat/completions")
    expect(MODELS_URL).toBe("https://api.meta.ai/v1/models")
  })
})

describe("meta session-info", () => {
  it("parses OpenAI-style rate-limit headers into req/tok windows", () => {
    const rl = new Map([
      ["x-ratelimit-limit-requests", "3000"],
      ["x-ratelimit-remaining-requests", "2990"],
      ["x-ratelimit-limit-tokens", "4000000"],
      ["x-ratelimit-remaining-tokens", "3990000"],
    ])
    const windows = parseMetaQuotaWindows(rl)
    expect(windows.map((w) => w.id)).toEqual(["req", "tok"])
    expect(windows[0]!.utilization).toBeCloseTo(10 / 3000, 6)
  })

  it("fetchSessionInfo returns context + quota from header cache", async () => {
    clearMetaRateLimits()
    setMetaRateLimits(
      new Headers({
        "x-ratelimit-limit-requests": "3000",
        "x-ratelimit-remaining-requests": "3000",
        "x-ratelimit-limit-tokens": "4000000",
        "x-ratelimit-remaining-tokens": "4000000",
      }),
    )
    setup()
    const info = await fetchMetaSessionInfo({
      modelId: "muse-spark-1.2",
      signal: undefined,
    })
    expect(info?.contextWindow).toBe(1_048_576)
    expect(info?.modelLabel).toBe("Muse Spark 1.2")
    expect(info?.quota?.windows?.length).toBe(2)
    clearMetaRateLimits()
  })
})

describe("meta adapter errors", () => {
  it("tags 401 invalid_api_key with helpful message", async () => {
    setup()
    const model = reg.resolveModel("muse-spark-1.2")
    const err = await drainCatch(
      metaAdapter.run(
        {
          modelId: model.id,
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          stream: true,
        },
        model,
        {
          auth: { kind: "api-key", key: "bad" },
          networkClient: fakeNetworkClient(
            401,
            JSON.stringify({
              error: { message: "Incorrect API key", type: "invalid_api_key", code: null },
            }),
          ),
        } as RunContext,
      ),
    )
    expect(err?.message).toMatch(/invalid API key/i)
    expect(err?.message).toMatch(/dev\.meta\.ai/)
  })

  it("rejects missing api-key", async () => {
    setup()
    const model = reg.resolveModel("muse-spark-1.2")
    const err = await drainCatch(
      metaAdapter.run(
        {
          modelId: model.id,
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          stream: true,
        },
        model,
        {
          auth: { kind: "api-key", key: "" },
          networkClient: fakeNetworkClient(200, ""),
        } as RunContext,
      ),
    )
    expect(err?.message).toMatch(/missing api-key/i)
  })
})
