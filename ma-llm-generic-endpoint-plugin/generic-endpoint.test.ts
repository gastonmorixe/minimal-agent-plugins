/**
 * Generic endpoint provider tests.
 *
 * Exercises endpoint normalization, config reading, ad-hoc model registration,
 * and adapter delegation to a mock SurfaceCodec + mock network client. No live
 * network.
 */

import { describe, expect, it } from "bun:test"

import {
  bootstrapGenericEndpoint,
  genericEndpointAdapter,
  registerGenericEndpointAdHocModel,
} from "./adapter.ts"
import { normalizeEndpoint, readGenericEndpointConfig } from "./config.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import { defaultCapabilities } from "./lib/capabilities.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import type { NetworkClient, NetworkRequestInput, NetworkResponse } from "./lib/net-types.ts"
import type { RunContext } from "./lib/provider-auth.ts"
import type { SurfaceCodec, SurfaceCodecRegistry } from "./lib/surface-codec.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"

const RATE = {
  inputUSD: 1,
  outputUSD: 2,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}

function makeCodecRegistry(codecs: SurfaceCodec[]): SurfaceCodecRegistry {
  const byId = new Map(codecs.map((c) => [c.surfaceId, c]))
  return {
    register(c) {
      byId.set(c.surfaceId, c)
    },
    find(id) {
      return byId.get(id)
    },
    list() {
      return [...byId.values()]
    },
  }
}

function sseStream(raw: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(raw)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function mockResponse(body: string, status = 200): NetworkResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    body: sseStream(body),
    transport: { id: "test" },
    async text() {
      return body
    },
    async json() {
      return JSON.parse(body)
    },
  }
}

function setEnv(env: Record<string, string | undefined>): () => void {
  const keys = [
    "MINIMAL_AGENT_ENDPOINT",
    "MINIMAL_AGENT_FORMAT",
    "MINIMAL_AGENT_SURFACE",
    "MINIMAL_AGENT_PROVIDER_MODEL",
    "MINIMAL_AGENT_EFFORT_LEVELS",
  ]
  const prev: Record<string, string | undefined> = {}
  for (const k of keys) prev[k] = process.env[k]
  for (const k of keys) delete process.env[k]
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v
  return () => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

describe("normalizeEndpoint", () => {
  it("appends the default path to a base URL", () => {
    expect(normalizeEndpoint("http://localhost:1234", "/v1/chat/completions")).toBe(
      "http://localhost:1234/v1/chat/completions",
    )
  })

  it("keeps a full endpoint that already has the path", () => {
    expect(
      normalizeEndpoint("http://localhost:1234/v1/chat/completions", "/v1/chat/completions"),
    ).toBe("http://localhost:1234/v1/chat/completions")
  })

  it("strips trailing slashes before appending", () => {
    expect(normalizeEndpoint("http://localhost:1234/", "/v1/chat/completions")).toBe(
      "http://localhost:1234/v1/chat/completions",
    )
  })
})

describe("readGenericEndpointConfig", () => {
  it("requires an endpoint", () => {
    const restore = setEnv({ MINIMAL_AGENT_FORMAT: "openai-chat-completions" })
    try {
      expect(() => readGenericEndpointConfig()).toThrow(/missing --endpoint/)
    } finally {
      restore()
    }
  })

  it("requires a format", () => {
    const restore = setEnv({ MINIMAL_AGENT_ENDPOINT: "http://localhost:1234" })
    try {
      expect(() => readGenericEndpointConfig()).toThrow(/missing --format/)
    } finally {
      restore()
    }
  })

  it("reads --surface alias and provider-model", () => {
    const restore = setEnv({
      MINIMAL_AGENT_ENDPOINT: "http://localhost:1234",
      MINIMAL_AGENT_SURFACE: "openai-chat-completions",
      MINIMAL_AGENT_PROVIDER_MODEL: "qwen2.5",
    })
    try {
      expect(readGenericEndpointConfig()).toEqual({
        endpoint: "http://localhost:1234",
        format: "openai-chat-completions",
        providerModel: "qwen2.5",
      })
    } finally {
      restore()
    }
  })
})

describe("generic endpoint adapter", () => {
  it("registers an ad-hoc model using codec defaults and provider-model", () => {
    const restore = setEnv({
      MINIMAL_AGENT_ENDPOINT: "http://localhost:1234",
      MINIMAL_AGENT_FORMAT: "mock-surface",
      MINIMAL_AGENT_PROVIDER_MODEL: "wire-model",
    })
    try {
      const codec: SurfaceCodec = {
        surfaceId: "mock-surface",
        displayName: "Mock",
        defaultPath: "/v1/chat/completions",
        defaultCapabilities: defaultCapabilities(),
        defaultPricing: RATE,
        defaultTags: ["mock", "generic"],
        validate: () => ({ ok: true, errors: [] }),
        buildRequest: ({ endpoint }) => ({ label: "mock", method: "POST", url: endpoint }),
        async *translateStream() {},
      }
      const registry = makeTestRegistry()
      bootstrapGenericEndpoint({
        models: registry.models,
        providers: registry.providers,
        surfaceCodecs: makeCodecRegistry([codec]),
      })
      registerGenericEndpointAdHocModel("local-model")
      const model = registry.resolveModel("local-model")
      expect(model.providerId).toBe("generic-endpoint")
      expect(model.surfaceId).toBe("mock-surface")
      expect(model.pricing).toEqual(RATE)
      expect(model.tags).toEqual(["mock", "generic"])
      expect(model.vendorIds?.firstParty).toBe("wire-model")
      // No effort ladder configured → codec default caps unchanged.
      expect(model.capabilities.effort.levels).toEqual(defaultCapabilities().effort.levels)
    } finally {
      restore()
    }
  })

  it("advertises the configured effort ladder on the ad-hoc model", () => {
    const restore = setEnv({
      MINIMAL_AGENT_ENDPOINT: "http://localhost:1234",
      MINIMAL_AGENT_FORMAT: "mock-surface",
      MINIMAL_AGENT_EFFORT_LEVELS: "low,medium,high",
    })
    try {
      const codec: SurfaceCodec = {
        surfaceId: "mock-surface",
        displayName: "Mock",
        defaultPath: "/v1/chat/completions",
        defaultCapabilities: defaultCapabilities(),
        defaultPricing: RATE,
        validate: () => ({ ok: true, errors: [] }),
        buildRequest: ({ endpoint }) => ({ label: "mock", method: "POST", url: endpoint }),
        async *translateStream() {},
      }
      const registry = makeTestRegistry()
      bootstrapGenericEndpoint({
        models: registry.models,
        providers: registry.providers,
        surfaceCodecs: makeCodecRegistry([codec]),
      })
      registerGenericEndpointAdHocModel("local-model")
      const model = registry.resolveModel("local-model")
      expect(model.capabilities.effort.levels).toEqual(["low", "medium", "high"])
      expect(model.capabilities.effort.default).toBe("high")
    } finally {
      restore()
    }
  })

  it("delegates run to the selected codec against the normalized endpoint", async () => {
    const restore = setEnv({
      MINIMAL_AGENT_ENDPOINT: "http://localhost:1234",
      MINIMAL_AGENT_FORMAT: "mock-surface",
    })
    try {
      let builtEndpoint = ""
      const codec: SurfaceCodec = {
        surfaceId: "mock-surface",
        displayName: "Mock",
        defaultPath: "/v1/chat/completions",
        defaultCapabilities: defaultCapabilities(),
        defaultPricing: RATE,
        validate: () => ({ ok: true, errors: [] }),
        buildRequest: ({ endpoint }): NetworkRequestInput => {
          builtEndpoint = endpoint
          return { label: "mock", method: "POST", url: endpoint, body: "{}" }
        },
        async *translateStream() {
          yield {
            type: "message_start",
            messageId: "m",
            modelId: "local-model",
            initialUsage: { inputTokens: 0, outputTokens: 0 },
          }
          yield { type: "message_stop" }
        },
      }
      const registry = makeTestRegistry()
      bootstrapGenericEndpoint({
        models: registry.models,
        providers: registry.providers,
        surfaceCodecs: makeCodecRegistry([codec]),
      })

      let requested: NetworkRequestInput | undefined
      const networkClient: NetworkClient = {
        async request(input) {
          requested = input
          return mockResponse("data: [DONE]\n\n")
        },
      }
      const model: ModelEntry = {
        id: "local-model",
        providerId: "generic-endpoint",
        surfaceId: "mock-surface",
        displayName: "local-model",
        capabilities: defaultCapabilities(),
        pricing: RATE,
        vendorIds: { firstParty: "local-model" },
      }
      const req: CanonicalRequest = { modelId: "local-model", messages: [] }
      const ctx: RunContext = {
        auth: { kind: "custom", headers: {} },
        sessionId: "",
        networkClient,
      }
      const events: CanonicalEvent[] = []
      for await (const ev of genericEndpointAdapter.run(req, model, ctx)) events.push(ev)

      expect(builtEndpoint).toBe("http://localhost:1234/v1/chat/completions")
      expect(requested?.url).toBe("http://localhost:1234/v1/chat/completions")
      expect(events.map((e) => e.type)).toEqual(["message_start", "message_stop"])
    } finally {
      restore()
    }
  })

  it("throws a helpful error for an unknown format", async () => {
    const restore = setEnv({
      MINIMAL_AGENT_ENDPOINT: "http://localhost:1234",
      MINIMAL_AGENT_FORMAT: "does-not-exist",
    })
    try {
      const registry = makeTestRegistry()
      bootstrapGenericEndpoint({
        models: registry.models,
        providers: registry.providers,
        surfaceCodecs: makeCodecRegistry([]),
      })
      const model: ModelEntry = {
        id: "local-model",
        providerId: "generic-endpoint",
        surfaceId: "x",
        displayName: "local-model",
        capabilities: defaultCapabilities(),
        pricing: RATE,
      }
      const req: CanonicalRequest = { modelId: "local-model", messages: [] }
      const ctx: RunContext = { auth: { kind: "custom", headers: {} }, sessionId: "" }
      await expect(async () => {
        for await (const _ of genericEndpointAdapter.run(req, model, ctx)) void _
      }).toThrow(/unknown format "does-not-exist"/)
    } finally {
      restore()
    }
  })
})
