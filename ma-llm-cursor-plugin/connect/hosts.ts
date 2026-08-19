/**
 * Cursor Connect host defaults + env overrides.
 *
 * @module llm/providers/cursor/connect/hosts
 */

import {
  CURSOR_AGENT_BASE,
  CURSOR_API_BASE,
  CURSOR_AUTH_USAGE_PATH,
  CURSOR_RPC_AGENT_RUN,
  CURSOR_RPC_AVAILABLE_MODELS,
  CURSOR_RPC_GET_CURRENT_PERIOD_USAGE,
  CURSOR_RPC_GET_SERVER_CONFIG,
  CURSOR_RPC_GET_USABLE_MODELS,
  CURSOR_WEBSITE_URL,
} from "../wire-constants.ts"

/** Unary AiService base URL (no trailing slash). */
export function apiBase(): string {
  return CURSOR_API_BASE
}

let overlayAgentBase: string | undefined

/** Overlay AgentService base from GetServerConfig (ignored when env is set). */
export function overlayAgentBaseUrl(url: string): void {
  const trimmed = url.trim().replace(/\/$/, "")
  if (trimmed) overlayAgentBase = trimmed
}

/** Test helper. */
export function resetAgentBaseOverlayForTests(): void {
  overlayAgentBase = undefined
}

/** AgentService base URL (no trailing slash). */
export function agentBase(): string {
  const env = process.env.MA_CURSOR_AGENT_ENDPOINT?.replace(/\/$/, "")
  if (env) return env
  return overlayAgentBase ?? CURSOR_AGENT_BASE
}

/** Website origin for login URLs. */
export function websiteUrl(): string {
  return CURSOR_WEBSITE_URL
}

/** Full URL for AvailableModels unary RPC. */
export function availableModelsUrl(): string {
  return `${apiBase()}/${CURSOR_RPC_AVAILABLE_MODELS}`
}

/** Full URL for GetUsableModels unary RPC. */
export function getUsableModelsUrl(): string {
  return `${agentBase()}/${CURSOR_RPC_GET_USABLE_MODELS}`
}

/** Full URL for GetServerConfig unary RPC. */
export function getServerConfigUrl(): string {
  return `${apiBase()}/${CURSOR_RPC_GET_SERVER_CONFIG}`
}

/** Full URL for DashboardService GetCurrentPeriodUsage (JSON Connect). */
export function currentPeriodUsageUrl(): string {
  return `${apiBase()}/${CURSOR_RPC_GET_CURRENT_PERIOD_USAGE}`
}

/** Full URL for legacy `GET /auth/usage` request buckets. */
export function authUsageUrl(): string {
  return `${apiBase()}${CURSOR_AUTH_USAGE_PATH}`
}

/** Full URL for AgentService/Run stream RPC. */
export function agentRunUrl(): string {
  return `${agentBase()}/${CURSOR_RPC_AGENT_RUN}`
}
