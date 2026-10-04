/** Structured Cursor MCP bridge resolution and host dispatch validation. */
import { readFileSync } from "node:fs"

import { argumentsForValidation, isArgumentObject, validateMcpArguments } from "./mcp-schema.ts"
import type { DecodedExecMcpArgs } from "./proto/exec-server-decode.ts"
import { decodeAgentServerExec } from "./proto/exec-server-decode.ts"
import type { CursorMcpToolWire } from "./proto/mcp-tools.ts"

const BRIDGE_NAMES = new Set(["GetDynamicTools", "CallDynamicTool"])
const TOOL_CATALOG_PREAMBLE = readFileSync(
  new URL("./prompts/tool-catalog.md", import.meta.url),
  "utf8",
).trim()

export type UnregisteredMcpExec = { exec: DecodedExecMcpArgs; replyText: string; ok: boolean }
export type CursorMcpResolution = { exec: DecodedExecMcpArgs; reply?: UnregisteredMcpExec }

function toolCatalogText(tools: readonly CursorMcpToolWire[]): string {
  return [
    TOOL_CATALOG_PREAMBLE,
    ...tools.map(
      (t) =>
        `## ${t.toolName}\nNamespace: ${t.providerIdentifier}\n${t.description}\n\ninput_schema: ${t.inputSchemaJson}`,
    ),
  ].join("\n\n")
}

/** Resolve only actual MCP exec frames. Assistant prose is never an execution source. */
export function resolveCursorMcpExec(
  payload: Uint8Array,
  tools: readonly CursorMcpToolWire[],
): CursorMcpResolution | undefined {
  const original = decodeAgentServerExec(payload)
  if (!original || original.nativeExecFieldNo !== undefined) return undefined
  const name = original.maToolName ?? original.toolName
  const reject = (text: string): CursorMcpResolution => ({
    exec: original,
    reply: { exec: original, ok: false, replyText: text },
  })
  if (!name) return reject("MCP tool name is required.")
  let target = tools.find(
    (t) => t.toolName === name && t.providerIdentifier === original.providerIdentifier,
  )
  let exec = original
  const providerAllowed = tools.some((t) => t.providerIdentifier === original.providerIdentifier)
  // A registered tool literally named like a bridge takes priority.
  if (!target && BRIDGE_NAMES.has(name)) {
    if (!providerAllowed) return reject("MCP bridge provider is not registered.")
    const input = original.input ?? {}
    if (name === "GetDynamicTools") {
      if (
        (input.namespace !== undefined && typeof input.namespace !== "string") ||
        (input.toolName !== undefined && typeof input.toolName !== "string")
      )
        return reject("Discovery filters must be strings.")
      const filtered = tools.filter(
        (t) =>
          (input.namespace === undefined || t.providerIdentifier === input.namespace) &&
          (input.toolName === undefined || t.toolName === input.toolName),
      )
      return {
        exec: original,
        reply: { exec: original, ok: true, replyText: toolCatalogText(filtered) },
      }
    }
    if (
      typeof input.namespace !== "string" ||
      typeof input.toolName !== "string" ||
      !isArgumentObject(input.arguments)
    )
      return reject("CallDynamicTool requires namespace, toolName, and object arguments.")
    if (BRIDGE_NAMES.has(input.toolName))
      return reject("Recursive MCP bridge calls are not allowed.")
    target = tools.find(
      (t) => t.providerIdentifier === input.namespace && t.toolName === input.toolName,
    )
    if (!target) return reject("CallDynamicTool target is not registered in that namespace.")
    exec = {
      ...original,
      providerIdentifier: target.providerIdentifier,
      toolName: target.toolName,
      maToolName: target.toolName,
      input: input.arguments,
    }
  }
  if (!target)
    return reject(`Tool "${name}" does not exist in that provider. ${toolCatalogText(tools)}`)
  let schema: unknown
  try {
    schema = JSON.parse(target.inputSchemaJson)
  } catch {
    return reject("Registered tool schema is invalid JSON.")
  }
  const error = validateMcpArguments(
    schema,
    argumentsForValidation(target.toolName, exec.input ?? {}),
  )
  if (error) return reject(`Invalid arguments for ${target.toolName}: ${error}`)
  return { exec }
}

/** Compatibility helper: return only discovery replies and rejected requests. */
export function findUnregisteredMcpExec(
  payload: Uint8Array,
  tools: readonly CursorMcpToolWire[],
): UnregisteredMcpExec | undefined {
  return resolveCursorMcpExec(payload, tools)?.reply
}
