/**
 * Live encode A/B for AgentService/Run. Prints RequestedModel + end-stream code.
 * bun run scripts/probe-run-encode.ts
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveCursorAccessToken } from "../auth.ts"
import { cursorCaps } from "../capabilities.ts"
import { agentRunUrl } from "../connect/hosts.ts"
import { connectFrameProto, parseConnectFrames } from "../connect/stream.ts"
import { buildCursorHeaders } from "../headers.ts"
import { loadClientIds } from "../ids.ts"
import { parseJsonc } from "../lib/jsonc.ts"
import type { NetworkClient } from "../lib/net-types.ts"
import { registerCursorModels } from "../models.ts"
import { encodeAgentClientMessageRun } from "../proto/agent-run.ts"
import { decodeFields, fieldBytes, fieldString } from "../proto/wire.ts"
import { buildCursorAgentRunBody } from "../request-body.ts"
import { ensureCursorServerConfig } from "../server-config.ts"
import { CURSOR_SURFACE_AGENT_RUN } from "../wire-constants.ts"

const store = parseJsonc(
  await Bun.file(join(homedir(), ".minimal-agent", "auth.jsonc")).text(),
) as { entries?: Array<{ name?: string; id: string; secrets: Record<string, string> }> }
const entry = store.entries?.find((e) => e.name === "cursor-oauth-2")
if (!entry) throw new Error("no cursor-oauth-2")
const { readCursorOAuthAuth } = await import("../oauth-login.ts")
const auth = readCursorOAuthAuth(entry.secrets)!
const token = await resolveCursorAccessToken(auth)
await ensureCursorServerConfig(token)
const ids = await loadClientIds()
ids.sessionId = crypto.randomUUID()

const registrar = {
  register() {},
  setDefault() {},
}
registerCursorModels(registrar as never)

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

function requestedSummary(body: Uint8Array) {
  const run = fieldBytes(decodeFields(body).find((f) => f.no === 1)!)!
  const rm = decodeFields(fieldBytes(decodeFields(run).find((f) => f.no === 9)!)!)
  const modelId = fieldString(rm.find((f) => f.no === 1)!)
  const params = rm
    .filter((f) => f.no === 3)
    .map((f) => {
      const pv = decodeFields(fieldBytes(f)!)
      return `${fieldString(pv.find((p) => p.no === 1)!)}=${fieldString(pv.find((p) => p.no === 2)!)}`
    })
  const f7 = rm.find((f) => f.no === 7)
  const f8 = rm.find((f) => f.no === 8)
  return { modelId, params, builtIn: f7 ? f7.value : "omit", variant: f8 ? f8.value : "omit" }
}

async function post(label: string, body: Uint8Array) {
  const headers = buildCursorHeaders({ token, ids, streaming: true, clientType: "cli" })
  const framed = connectFrameProto(body)
  console.error(
    label,
    requestedSummary(body),
    "url",
    agentRunUrl(),
    "ver",
    headers["x-cursor-client-version"],
  )
  const res = await networkClient.request({
    label: "cursor-probe-run",
    method: "POST",
    url: agentRunUrl(),
    headers,
    body: framed,
    protocol: "h2",
    allowFetchFallback: false,
    timeoutMs: 15_000,
  })
  const chunks: Uint8Array[] = []
  if (res.body) {
    const reader = res.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
  }
  const n = chunks.reduce((a, c) => a + c.length, 0)
  const buf = new Uint8Array(n)
  let o = 0
  for (const c of chunks) {
    buf.set(c, o)
    o += c.length
  }
  const frames = parseConnectFrames(buf)
  const end = frames.find((f) => f.endStream)
  const text = end ? new TextDecoder().decode(end.payload).slice(0, 300) : "(no end-stream)"
  console.error(" ", "http", res.status, "frames", frames.length, "end", text)
}

const ZERO = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
} as const

const model = {
  id: "cursor-grok-4.6-high",
  providerId: "cursor",
  surfaceId: CURSOR_SURFACE_AGENT_RUN,
  displayName: "Cursor Grok 4.6 High",
  capabilities: cursorCaps({ thinking: true, effortLevels: ["high"], speedFast: true }),
  pricing: ZERO,
  vendorIds: { cursor: "grok-4.6" },
  tags: [
    "cursor",
    "variant",
    "parent:grok-4.6",
    "param:effort=high",
    "param:fast=false",
    "effort-param:effort",
    "fast-param:fast",
  ],
}

const req = {
  modelId: "cursor-grok-4.6-high",
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
}

await post("A catalog+tags", buildCursorAgentRunBody(req, model))

await post(
  "B variant-string f8",
  encodeAgentClientMessageRun({
    text: "user: hi",
    modelId: "grok-4.6[effort=high,fast=false]",
    isVariantStringRepresentation: true,
    parameters: [
      { id: "effort", value: "high" },
      { id: "fast", value: "false" },
    ],
  }),
)

await post(
  "C variant-string only",
  encodeAgentClientMessageRun({
    text: "user: hi",
    modelId: "grok-4.6[effort=high,fast=false]",
    isVariantStringRepresentation: true,
  }),
)

await post(
  "D parent no params",
  encodeAgentClientMessageRun({
    text: "user: hi",
    modelId: "grok-4.6",
  }),
)

await post(
  "E parent+params explicit",
  encodeAgentClientMessageRun({
    text: "user: hi",
    modelId: "grok-4.6",
    parameters: [
      { id: "effort", value: "high" },
      { id: "fast", value: "false" },
    ],
  }),
)

await post(
  "F auto default",
  encodeAgentClientMessageRun({
    text: "user: hi",
    modelId: "default",
  }),
)

await networkClient.close?.()
