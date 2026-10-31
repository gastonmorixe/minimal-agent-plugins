/**
 * Spawn-test fixture: a minimal ACP-shaped agent built on `transport.ts`,
 * with no real model and no core boot — the same role the spike's
 * `agent.ts` played (`research/acp-spike` in the umbrella repo), updated
 * to exercise THIS plugin's shared transport module instead of a one-off
 * copy. Used by `transport.spawn.test.ts` to prove stdout purity end to
 * end: a real OS process, real stdio, no mocking of the transport layer.
 *
 * Set `ACP_TEST_STRAY_WRITE=1` to make this fixture ALSO print one human
 * line straight to `process.stdout` (bypassing the transport) — the
 * negative control that proves the purity check in the test would catch
 * a real stdout-purity bug, not just pass by construction.
 *
 * @module __fixtures__/fake-acp-process
 */

import { createRpcChannel, RPC_ERROR, RpcError } from "../transport.ts"

// Reroute console.log to stderr, the same rule the real host-mode context
// applies (src/host/startup/run-host-mode.ts in minimal-agent-core): a
// stray console.log must never corrupt the NDJSON stream.
// biome-ignore lint/suspicious/noConsole: rerouting console.log itself.
console.log = (...a: unknown[]) => console.error(...a)

if (process.env.ACP_TEST_STRAY_WRITE === "1") {
  process.stdout.write("THIS LINE IS NOT JSON-RPC\n")
}

const aborts = new Map<string, AbortController>()

const channel = createRpcChannel({
  stdin: process.stdin,
  write: (line) => {
    process.stdout.write(line)
  },
  log: (msg) => console.error(`[fake-acp] ${msg}`),
  handlers: {
    requests: {
      initialize: () => ({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false },
        },
        agentInfo: { name: "fake-acp-process", version: "0.0.0" },
        authMethods: [],
      }),
      "session/new": () => {
        const sessionId = `sess_${Math.random().toString(36).slice(2)}`
        aborts.set(sessionId, new AbortController())
        return { sessionId }
      },
      "session/prompt": async (rawParams) => {
        const params = rawParams as { sessionId?: string }
        const ac = params.sessionId ? aborts.get(params.sessionId) : undefined
        if (!ac) throw new RpcError(RPC_ERROR.invalidParams, "unknown session")
        console.error("[fake-acp] prompt received")
        for (const word of ["hello", " ", "world"]) {
          if (ac.signal.aborted) break
          channel.notify("session/update", {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "msg_1",
              content: { type: "text", text: word },
            },
          })
          await Bun.sleep(50)
        }
        const stopReason = ac.signal.aborted ? "cancelled" : "end_turn"
        if (stopReason === "cancelled" && params.sessionId) {
          aborts.set(params.sessionId, new AbortController())
        }
        return { stopReason }
      },
    },
    notifications: {
      "session/cancel": (rawParams) => {
        const params = rawParams as { sessionId?: string }
        if (params.sessionId) aborts.get(params.sessionId)?.abort()
      },
    },
  },
})

await channel.closed
