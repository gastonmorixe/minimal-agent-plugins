/**
 * Cursor Connect host defaults + env overrides.
 *
 * @module llm/providers/cursor/connect/hosts
 */

import {
  CURSOR_AGENT_BASE,
  CURSOR_API_BASE,
  CURSOR_RPC_AGENT_RUN,
  CURSOR_RPC_AVAILABLE_MODELS,
  CURSOR_RPC_GET_USABLE_MODELS,
  CURSOR_WEBSITE_URL,
} from "../wire-constants.ts"

/** Unary AiService base URL (no trailing slash). */
export function apiBase(): string {
  return CURSOR_API_BASE
}

/** AgentService base URL (no trailing slash). */
export function agentBase(): string {
  return CURSOR_AGENT_BASE
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

/** Full URL for AgentService/Run stream RPC. */
export function agentRunUrl(): string {
  return `${agentBase()}/${CURSOR_RPC_AGENT_RUN}`
}
