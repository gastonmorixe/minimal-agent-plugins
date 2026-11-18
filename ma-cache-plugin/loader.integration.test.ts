/**
 * Integration: load this plugin through the real core PluginLoader, send one
 * Messages-shaped request through the real host network client to a local
 * server, and check the loader diagnostics handle.
 *
 * This proves the full path with no core change: manifest capability
 * `network:observe` → fragment `ctx.host.network` → wire taps → detector →
 * `ctx.log.warn` → the injected loader diagnostics handle, as one
 * warn-severity diagnostic with source `cache.anomaly`.
 *
 * @module cache/loader.integration.test
 */

import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { type LogEvent, Severity } from "@minimal-agent/core/host/diagnostics"
import { defaultNetworkClient } from "@minimal-agent/core/host/network"
import { PluginLoader, type PluginLoaderOptions } from "@minimal-agent/core/host-kit/plugin-loader"

const tmp = mkdtempSync(join(tmpdir(), "ma-cache-plugin-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** A root with only this plugin, so discovery does not load the whole fleet. */
function isolatedRoot(name = "root"): string {
  const dest = join(tmp, name, "ma-cache-plugin")
  cpSync(import.meta.dir, dest, {
    recursive: true,
    filter: (src) => !src.endsWith(".test.ts") && !src.includes("node_modules"),
  })
  return join(tmp, name)
}

const COLD_SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n'

describe("cache plugin via the real PluginLoader and network client", () => {
  it("a request with cache markers and 0 cache reads gives exactly one warn cache.anomaly", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(COLD_SSE, { headers: { "content-type": "text/event-stream" } }),
    })
    const events: LogEvent[] = []
    // The loader relay calls only `emit` on its base handle.
    const diagnostics = { sessionId: undefined, emit: (e: LogEvent) => events.push(e) }
    const loader = await PluginLoader.load({
      roots: { user: [isolatedRoot()] },
      logger: () => {},
      diagnostics: diagnostics as unknown as PluginLoaderOptions["diagnostics"],
    })
    try {
      // Fragments start at load. Resolve them so the watcher is attached.
      await loader.getPromptBlocksAsync()
      const body = JSON.stringify({
        model: "test-model",
        system: [{ type: "text", text: "x".repeat(20_000), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: "hi" }],
      })
      for (let i = 0; i < 2; i++) {
        const res = await defaultNetworkClient.request({
          label: "messages.send",
          method: "POST",
          url: `http://127.0.0.1:${server.port}/v1/messages`,
          headers: { "content-type": "application/json", "x-claude-code-session-id": "s-int" },
          body,
        })
        await res.text()
      }
      const cache = events.filter((e) => e.source === "cache.anomaly")
      expect(cache).toHaveLength(1)
      expect(cache[0]?.severity).toBe(Severity.Warning)
      expect(cache[0]?.structuredData).toEqual({ code: "markers_ignored_cold" })
      // The fragment adds no prompt text.
      const blocks = await loader.getPromptBlocksAsync()
      expect(blocks.afterInstructions).toBeNull()
    } finally {
      void server.stop(true)
    }
  })

  it("a target.didSwitch event on the loader bus resets the history (no false warning)", async () => {
    // A cache that reads, then a credential switch: the same model and endpoint,
    // and a cold cache (0 read, a write). Turn 3 must not warn.
    const usages = [
      [5000, 0],
      [5000, 0],
      [0, 5000],
    ]
    let n = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        const [read, create] = usages[n++] ?? [0, 0]
        return new Response(
          `event: message_start\ndata: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":${read},"cache_creation_input_tokens":${create}}}}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const events: LogEvent[] = []
    const diagnostics = { sessionId: undefined, emit: (e: LogEvent) => events.push(e) }
    const loader = await PluginLoader.load({
      roots: { user: [isolatedRoot("root-switch")] },
      logger: () => {},
      diagnostics: diagnostics as unknown as PluginLoaderOptions["diagnostics"],
    })
    const body = JSON.stringify({
      model: "switch-model",
      system: [{ type: "text", text: "x".repeat(20_000), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    })
    const send = async () => {
      const res = await defaultNetworkClient.request({
        label: "messages.send",
        method: "POST",
        url: `http://127.0.0.1:${server.port}/v1/messages`,
        headers: { "content-type": "application/json", "x-claude-code-session-id": "s-switch" },
        body,
      })
      await res.text()
    }
    try {
      await loader.getPromptBlocksAsync()
      await send()
      await send()
      // The host (cli live-target.ts) sends this after the switch.
      loader.bus().emit("target.didSwitch", {
        from: { model: "switch-model", credentialName: "a" },
        to: { model: "switch-model", credentialName: "b" },
      })
      // Listeners run on a microtask, and a module handler is imported on first use.
      await Bun.sleep(50)
      await send()
      expect(events.filter((e) => e.source === "cache.anomaly")).toEqual([])
    } finally {
      void server.stop(true)
    }
  })

  it("a response that streams across target.didSwitch is not counted in the new history", async () => {
    // Request 2 of the old credential starts. The server holds its body open,
    // the switch comes, then the body ends. Turn 3 (new credential) is cold.
    let n = 0
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    const sse = (read: number, create: number) =>
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":${read},"cache_creation_input_tokens":${create}}}}\n\n`
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        n++
        if (n === 1) return new Response(sse(5000, 100))
        if (n === 3) return new Response(sse(0, 5000))
        // n === 2: send the headers now, the usage only after the switch.
        const enc = new TextEncoder()
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(c) {
              c.enqueue(enc.encode(": open\n\n"))
              await held
              c.enqueue(enc.encode(sse(5000, 100)))
              c.close()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const events: LogEvent[] = []
    const diagnostics = { sessionId: undefined, emit: (e: LogEvent) => events.push(e) }
    const loader = await PluginLoader.load({
      roots: { user: [isolatedRoot("root-inflight")] },
      logger: () => {},
      diagnostics: diagnostics as unknown as PluginLoaderOptions["diagnostics"],
    })
    const body = JSON.stringify({
      model: "inflight-model",
      system: [{ type: "text", text: "x".repeat(20_000), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    })
    const request = () =>
      defaultNetworkClient.request({
        label: "messages.send",
        method: "POST",
        url: `http://127.0.0.1:${server.port}/v1/messages`,
        headers: { "content-type": "application/json", "x-claude-code-session-id": "s-inflight" },
        body,
      })
    try {
      await loader.getPromptBlocksAsync()
      await (await request()).text()
      const second = await request()
      const draining = second.text()
      loader.bus().emit("target.didSwitch", {
        from: { model: "inflight-model", credentialName: "a" },
        to: { model: "inflight-model", credentialName: "b" },
      })
      await Bun.sleep(50)
      release()
      await draining
      await (await request()).text()
      expect(events.filter((e) => e.source === "cache.anomaly")).toEqual([])
    } finally {
      void server.stop(true)
    }
  })
})
