/**
 * Live probe: conversation carry across fresh AgentService/Run requests.
 * Turn 1 calls a tool and ends. Turn 2 (fresh Run, carried checkpoint, only
 * the new user text) must recall the tool result and still make a real call.
 * bun run scripts/probe-carry.ts   (CRED=cursor-oauth-5 by default)
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { cursorAdapter } from "../adapter.ts"
import { cursorCaps } from "../capabilities.ts"
import { getCursorCarryState } from "../conversation-carry.ts"
import type { CanonicalMessage } from "../lib/canonical-messages.ts"
import { parseJsonc } from "../lib/jsonc.ts"
import type { NetworkClient } from "../lib/net-types.ts"
import { readCursorOAuthAuth } from "../oauth-login.ts"
import { CURSOR_SURFACE_AGENT_RUN } from "../wire-constants.ts"

const store = parseJsonc(
  await Bun.file(join(homedir(), ".minimal-agent", "auth.jsonc")).text(),
) as { entries?: Array<{ name?: string; secrets: Record<string, string> }> }
const entry = store.entries?.find((e) => e.name === (process.env.CRED ?? "cursor-oauth-5"))
if (!entry) throw new Error("no cursor credential")
const maybeAuth = readCursorOAuthAuth(entry.secrets as never)
if (!maybeAuth) throw new Error("bad cursor credential")
// Narrowed const, so the closure below sees ProviderAuth (not ProviderAuth | null).
const auth = maybeAuth

const coreNetwork = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "minimal-agent-core",
  "src",
  "network",
  "index.ts",
)
const { createDefaultNetworkClient } = (await import(pathToFileURL(coreNetwork).href)) as {
  createDefaultNetworkClient: () => NetworkClient
}
const networkClient = createDefaultNetworkClient()

const model = {
  id: "cursor-auto",
  providerId: "cursor",
  surfaceId: CURSOR_SURFACE_AGENT_RUN,
  displayName: "Auto",
  capabilities: cursorCaps(),
  pricing: { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0, webSearchPerCallUSD: 0 },
  vendorIds: { cursor: "default" },
}
const tools = [
  {
    name: "VaultLookup",
    description: "Look up a vault code by key. Returns the code.",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "ModelInfo",
    description: "Return session model metadata as JSON text.",
    inputSchema: { type: "object", properties: {} },
  },
]
const sessionId = `probe-carry-${crypto.randomUUID()}`
const system = [{ type: "text" as const, text: "You are a test agent. Use tools when asked." }]

type Turn = { text: string; tool?: { id: string; name: string; input: unknown } }

async function run(messages: CanonicalMessage[]): Promise<Turn> {
  let text = ""
  let tool: Turn["tool"]
  let toolInput = ""
  for await (const ev of cursorAdapter.run(
    { modelId: "cursor-auto", system, messages, tools },
    model,
    {
      auth,
      sessionId,
      networkClient,
    },
  )) {
    if (ev.type === "text_delta") text += ev.text
    if (ev.type === "tool_use_start") tool = { id: ev.id, name: ev.name, input: {} }
    if (ev.type === "tool_use_input_delta") toolInput += ev.partialJson
    if (ev.type === "stream_error") throw ev.cause ?? new Error("stream_error")
  }
  if (tool && toolInput) tool.input = JSON.parse(toolInput)
  return { text, tool }
}

const messages: CanonicalMessage[] = [
  {
    role: "user",
    content: [{ type: "text", text: "Call VaultLookup with key main. Then say done." }],
  },
]
const t1 = await run(messages)
console.log("turn1 tool:", t1.tool?.name, JSON.stringify(t1.tool?.input))
if (!t1.tool) throw new Error("turn1 made no tool call")
messages.push({
  role: "assistant",
  content: [
    ...(t1.text ? [{ type: "text" as const, text: t1.text }] : []),
    { type: "tool_use", id: t1.tool.id, name: t1.tool.name, input: t1.tool.input },
  ],
})
messages.push({
  role: "user",
  content: [
    {
      type: "tool_result",
      toolUseId: t1.tool.id,
      content: [{ type: "text", text: "vault code = PURPLE-4217" }],
    },
  ],
})
const t1b = await run(messages)
console.log("turn1 end text:", t1b.text.slice(0, 120))
messages.push({ role: "assistant", content: [{ type: "text", text: t1b.text || "done" }] })
const state = getCursorCarryState(sessionId)
console.log(
  "carry state:",
  state
    ? `covered=${state.coveredCount} checkpoint=${state.checkpoint.byteLength}B blobs=${state.blobs.size}`
    : "NONE",
)

messages.push({
  role: "user",
  content: [
    {
      type: "text",
      text: "First call the ModelInfo tool. After that, tell me the vault code from the earlier lookup.",
    },
  ],
})
const t2 = await run(messages)
console.log("turn2 tool:", t2.tool?.name ?? "NONE", "| text:", t2.text.slice(0, 160))
if (t2.tool) {
  messages.push({
    role: "assistant",
    content: [{ type: "tool_use", id: t2.tool.id, name: t2.tool.name, input: t2.tool.input }],
  })
  messages.push({
    role: "user",
    content: [
      {
        type: "tool_result",
        toolUseId: t2.tool.id,
        content: [{ type: "text", text: '{"model":"x"}' }],
      },
    ],
  })
  const t2b = await run(messages)
  console.log("turn2 end text:", t2b.text.slice(0, 200))
  console.log("RECALL:", t2b.text.includes("PURPLE-4217") ? "PASS" : "FAIL")
}
await networkClient.close?.()
