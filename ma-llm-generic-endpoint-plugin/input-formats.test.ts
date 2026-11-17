/**
 * Input formats and media limits of the generic endpoint (images only, from
 * the codec image flag or the user config), and the encoder output through
 * a codec built on the shared chat encoder (image_url or placeholder text).
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalBlock } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import {
  type Capabilities,
  defaultCapabilities,
} from "@minimal-agent/core/plugin-api/llm/capabilities"
import { modalityViolations } from "@minimal-agent/core/plugin-api/llm/modality-check"
import { buildOpenAIChatBody } from "@minimal-agent/core/plugin-api/llm/openai-chat"
import type {
  SurfaceCodec,
  SurfaceCodecRegistry,
} from "@minimal-agent/core/plugin-api/llm/surface-codec"

import {
  bootstrapGenericEndpoint,
  genericEndpointAdapter,
  registerGenericEndpointAdHocModel,
} from "./adapter.ts"
import { readGenericEndpointConfig } from "./config.ts"
import { GENERIC_IMAGE_MIME_TYPES } from "./input-formats.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"

const RATE = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}
const ENV_KEYS = ["MINIMAL_AGENT_ENDPOINT", "MINIMAL_AGENT_FORMAT", "MINIMAL_AGENT_IMAGE_INPUT"]

/** A codec on the shared chat encoder; its body goes to `sent`. */
function chatCodec(caps: Capabilities, sent: { body?: string }): SurfaceCodec {
  return {
    surfaceId: "mock-chat",
    displayName: "Mock chat",
    defaultPath: "/v1/chat/completions",
    defaultCapabilities: caps,
    defaultPricing: RATE,
    validate: (req, model) => {
      const errors = modalityViolations(req.messages, model.capabilities, model.id)
      return { ok: errors.length === 0, errors }
    },
    buildRequest: ({ req, model, endpoint }) => {
      sent.body = JSON.stringify(buildOpenAIChatBody(req, model as never))
      return { label: "mock", method: "POST", url: endpoint, body: sent.body }
    },
    async *translateStream() {},
  }
}

function codecs(codec: SurfaceCodec): SurfaceCodecRegistry {
  return {
    register() {},
    find: (id) => (id === codec.surfaceId ? codec : undefined),
    list: () => [codec],
  }
}

/** Register "local" with the codec and env; return the model and the sent body. */
function setup(caps: Capabilities, imageInput?: string) {
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.MINIMAL_AGENT_ENDPOINT = "http://localhost:1234"
  process.env.MINIMAL_AGENT_FORMAT = "mock-chat"
  if (imageInput === undefined) delete process.env.MINIMAL_AGENT_IMAGE_INPUT
  else process.env.MINIMAL_AGENT_IMAGE_INPUT = imageInput
  const sent: { body?: string } = {}
  const reg = makeTestRegistry()
  bootstrapGenericEndpoint({
    models: reg.models,
    providers: reg.providers,
    surfaceCodecs: codecs(chatCodec(caps, sent)),
  })
  registerGenericEndpointAdHocModel("local")
  const restore = () => {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
  return { model: reg.resolveModel("local"), sent, restore }
}

const ALL_ON: Capabilities = {
  ...defaultCapabilities(),
  modalities: { image: true, audio: true, pdf: true, video: true },
  inputMimeTypes: ["image/png", "application/pdf", "audio/wav", "video/mp4"],
}

describe("generic endpoint input formats", () => {
  it("a codec with image input gives images only (no PDF, audio or video)", () => {
    const { model, restore } = setup(ALL_ON)
    try {
      expect(model.capabilities.modalities).toEqual({
        image: true,
        audio: false,
        pdf: false,
        video: false,
      })
      expect(model.capabilities.inputMimeTypes).toEqual(["image/png"])
    } finally {
      restore()
    }
  })

  it("a codec with no image input gives no attachment", () => {
    const { model, restore } = setup(defaultCapabilities())
    try {
      expect(model.capabilities.inputMimeTypes).toEqual([])
      expect(genericEndpointAdapter.mediaLimits!(model).acceptedMimeTypes.size).toBe(0)
    } finally {
      restore()
    }
  })

  it("the user config turns images on or off", () => {
    const on = setup(defaultCapabilities(), "on")
    try {
      expect(on.model.capabilities.modalities.image).toBe(true)
      expect(on.model.capabilities.inputMimeTypes).toEqual(GENERIC_IMAGE_MIME_TYPES)
    } finally {
      on.restore()
    }
    const off = setup(ALL_ON, "0")
    try {
      expect(off.model.capabilities.modalities.image).toBe(false)
      expect(off.model.capabilities.inputMimeTypes).toEqual([])
    } finally {
      off.restore()
    }
  })

  it("the config parses the switch; unknown text is no override", () => {
    const base = { MINIMAL_AGENT_ENDPOINT: "http://x", MINIMAL_AGENT_FORMAT: "f" }
    expect(
      readGenericEndpointConfig({ ...base, MINIMAL_AGENT_IMAGE_INPUT: "true" }).imageInput,
    ).toBe(true)
    expect(
      readGenericEndpointConfig({ ...base, MINIMAL_AGENT_IMAGE_INPUT: "off" }).imageInput,
    ).toBe(false)
    expect(
      readGenericEndpointConfig({ ...base, MINIMAL_AGENT_IMAGE_INPUT: "maybe" }),
    ).not.toHaveProperty("imageInput")
  })

  it("mediaLimits gives the model list and the core default sizes", () => {
    const { model, restore } = setup(defaultCapabilities(), "1")
    try {
      const limits = genericEndpointAdapter.mediaLimits!(model)
      expect([...limits.acceptedMimeTypes]).toEqual([...GENERIC_IMAGE_MIME_TYPES])
      expect(limits.maxBytesPerItem).toBe(5 * 1024 * 1024)
      expect(limits.maxRequestBytes).toBe(32 * 1024 * 1024)
      expect(limits.maxItemsPerRequest).toBe(100)
      expect(limits.maxDimension).toBe(8000)
    } finally {
      restore()
    }
  })
})

describe("generic endpoint encoder attachments (shared chat codec)", () => {
  it("validate rejects PDF, audio and video; the image passes", () => {
    const { model, restore } = setup(ALL_ON)
    try {
      const content: CanonicalBlock[] = [
        { type: "image", source: { kind: "base64", mediaType: "image/png", data: "I" } },
        { type: "file", source: { kind: "base64", mediaType: "application/pdf", data: "P" } },
        { type: "audio", source: { kind: "base64", format: "wav", data: "A" } },
        { type: "video", source: { kind: "url", url: "https://x/v.mp4" } },
      ]
      const res = genericEndpointAdapter.validate(
        { modelId: "local", messages: [{ role: "user", content }] },
        model,
      )
      const text = res.errors.map((e) => e.message).join("\n")
      expect(res.errors).toHaveLength(3)
      expect(text).toContain("audio")
      expect(text).toContain("video")
      expect(text).toContain("PDF")
      expect(text).not.toContain("image")
    } finally {
      restore()
    }
  })

  it("sends an image as image_url and a video as the placeholder text", async () => {
    const { model, sent, restore } = setup(ALL_ON)
    try {
      const networkClient = {
        request: async () => {
          throw new Error("stop")
        },
      }
      const run = genericEndpointAdapter.run(
        {
          modelId: "local",
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { kind: "base64", mediaType: "image/png", data: "I" } },
                { type: "video", source: { kind: "url", url: "https://x/v.mp4" } },
              ],
            },
          ],
        },
        model,
        { auth: { kind: "api-key", key: "k" }, networkClient } as never,
      )
      await expect(
        (async () => {
          for await (const _ of run) {
            // no events
          }
        })(),
      ).rejects.toThrow("stop")
      const body = JSON.parse(sent.body ?? "{}") as { messages: Array<{ content: unknown }> }
      expect(body.messages[0]?.content).toEqual([
        { type: "image_url", image_url: { url: "data:image/png;base64,I" } },
        { type: "text", text: "[video attachment not sent: local does not accept video]" },
      ])
    } finally {
      restore()
    }
  })
})
