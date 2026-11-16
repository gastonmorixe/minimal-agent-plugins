/**
 * Per-request header builder for the Anthropic Messages API.
 *
 * Mirrors the claude-code 2.1.325 capture
 * (research/2026-11-15-cc-2.1.325-oauth-diff/cc-wire.md). New code goes
 * here; the legacy `src/headers.ts` retains its `buildHeaders` for backward
 * compatibility until Phase 7 removes it.
 *
 * @module llm/providers/anthropic/headers
 */

import { randomUUID } from "node:crypto"

import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import type { ProviderAuth } from "@minimal-agent/core/plugin-api/llm/provider-auth"

import {
  type AnthropicBetaFlag,
  type AnthropicRequestKind,
  buildBetaFlags,
  classifyRequest,
} from "./beta-flags.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import { ANTHROPIC_VERSION, STAINLESS_SDK_VERSION, USER_AGENT } from "./wire-constants.ts"

export interface AnthropicHeadersOptions {
  req: CanonicalRequest
  model: ModelEntry
  auth: ProviderAuth
  sessionId: string
  /** Override the per-request UUID. Defaults to a fresh `randomUUID()`. */
  clientRequestId?: string
  /**
   * Leave out the request-class headers (non-/v1/messages calls such as the
   * models list, which CC sends through a different path).
   */
  omitRequestClass?: boolean
}

/** CC `F_n` / `$_n` header names (CC/chunk-e44qnbvj.mjs). */
export const REQUEST_CLASS_HEADER = "x-claude-code-request-class"
export const FIRST_PARTY_REQUEST_CLASS_HEADER = "x-claude-1p-request-class"

/** One `x-claude-code-request-class` / `x-claude-1p-request-class` pair. */
export interface RequestClass {
  code: string
  firstParty: string
}

/**
 * CC 2.1.325 gateway-hint classes. Evidence:
 * research/2026-11-15-cc-2.1.325-oauth-diff/betas-headers.md §5:
 * - CC `ZAa`/`po` (code class ∈ main|subagent|workflow|compaction|auxiliary|
 *   side_reply) and `tRa` (1p class ∈ main|blocking-subagent|background-task|
 *   summary-extraction|followup-generation), CC/chunk-e44qnbvj.mjs.
 * - main: `repl_main_thread` → main / main (D capture: the lead loop).
 * - subagent: `agent:*` → `po` "subagent"; `tRa` "background-task" unless the
 *   agent is blocking. D capture: 15/15 Agent-tool requests are
 *   subagent / background-task (cc-wire.md, SUBAGENT row).
 * - compaction: `ZAa` returns "compaction" for querySource `compact`; `tRa`
 *   falls through to "summary-extraction" (betas-headers.md §5 mapping).
 * - auxiliary: side queries with no user-turn source (D capture: the haiku
 *   title request and the haiku-4-5 quota probe are both
 *   auxiliary / summary-extraction).
 */
export const REQUEST_CLASSES = {
  main: { code: "main", firstParty: "main" },
  subagent: { code: "subagent", firstParty: "background-task" },
  compaction: { code: "compaction", firstParty: "summary-extraction" },
  auxiliary: { code: "auxiliary", firstParty: "summary-extraction" },
} as const satisfies Record<string, RequestClass>

/**
 * True in a sub-agent worker process. The host stamps
 * `MINIMAL_AGENT_SUBAGENT_ID` on every sub-agent it spawns (core
 * `runtime/host-session-facts.ts` `subagentIdentity`); the plugin reads the
 * env directly so it does not import core `src/`.
 */
export function isSubagentProcess(): boolean {
  return (process.env.MINIMAL_AGENT_SUBAGENT_ID?.trim() ?? "") !== ""
}

/**
 * Pick the request class from the request's PURPOSE, not its beta kind: the
 * `subtask` kind only means "≤1 tool and no 1h cache" and says nothing about
 * who sent it.
 * - title / quota probes → auxiliary / summary-extraction;
 * - `purpose: "compaction"` (core run-compact) → compaction / summary-extraction;
 * - any other request from a sub-agent process → subagent / background-task;
 * - everything else (the lead loop) → main / main.
 */
export function requestClassFor(req: CanonicalRequest, kind: AnthropicRequestKind): RequestClass {
  if (kind === "title" || kind === "quota") return REQUEST_CLASSES.auxiliary
  if (req.purpose === "compaction") return REQUEST_CLASSES.compaction
  if (isSubagentProcess()) return REQUEST_CLASSES.subagent
  return REQUEST_CLASSES.main
}

/**
 * Build the full header map. The order is not significant for HTTP
 * but matches the live capture for diff-ability.
 *
 * Returns `{ headers, betaFlags }` so the caller can record the
 * resolved flag list for diagnostics without re-running the assembler.
 */
export function buildAnthropicHeaders(opts: AnthropicHeadersOptions): {
  headers: Record<string, string>
  betaFlags: AnthropicBetaFlag[]
} {
  const { req, model, auth, sessionId, clientRequestId, omitRequestClass } = opts
  const kind = classifyRequest(req)
  const betaFlags = buildBetaFlags({
    kind,
    req,
    model,
    authKind: auth.kind,
  })

  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    "user-agent": USER_AGENT,
    "x-app": "cli",
    "x-claude-code-session-id": sessionId,
    "x-client-request-id": clientRequestId ?? randomUUID(),
  }

  if (auth.kind === "api-key") {
    headers["x-api-key"] = auth.key
    if (auth.organization) headers["anthropic-organization"] = auth.organization
    if (auth.project) headers["anthropic-project"] = auth.project
  } else if (auth.kind === "oauth") {
    headers["authorization"] = `Bearer ${auth.token}`
    headers["anthropic-beta"] = betaFlags.join(",")
    headers["anthropic-dangerous-direct-browser-access"] = "true"
    // CC `a1r()` turns the gateway hint headers on for first party with the
    // default base URL (`Ss()`), CC/chunk-0s5xarq7.mjs `jB`. OAuth here means
    // api.anthropic.com; api-key and custom (other base URL) get none.
    if (!omitRequestClass) {
      const cls = requestClassFor(req, kind)
      headers[REQUEST_CLASS_HEADER] = cls.code
      headers[FIRST_PARTY_REQUEST_CLASS_HEADER] = cls.firstParty
    }
  } else {
    Object.assign(headers, auth.headers)
    if (betaFlags.length > 0) headers["anthropic-beta"] = betaFlags.join(",")
  }

  // Stainless metadata. Mirrors what the SDK injects.
  headers["x-stainless-arch"] = process.arch
  headers["x-stainless-lang"] = "js"
  headers["x-stainless-os"] = process.platform === "darwin" ? "MacOS" : process.platform
  headers["x-stainless-package-version"] = STAINLESS_SDK_VERSION
  headers["x-stainless-retry-count"] = "0"
  headers["x-stainless-runtime"] = "node"
  headers["x-stainless-runtime-version"] = process.version
  headers["x-stainless-timeout"] = "600"

  return { headers, betaFlags }
}
