/**
 * Wire constants for the Cursor provider (MVP).
 *
 * Hosts and content-types from the live spike + PLAN.md. Env overrides let
 * operators point at staging without rebuilding.
 *
 * @module llm/providers/cursor/wire-constants
 */

/**
 * Env policy (Gaston):
 * - Auth tokens/keys: NEVER read process.env for secrets. Only MA auth store via
 *   apiKeyAuth / oauthLogin (core manages credentials).
 * - Optional non-secret overrides: MA_CURSOR_* only (not bare CURSOR_*).
 */

/** Unary AiService base (AvailableModels, GetMe, auth exchange, …). */
export const CURSOR_API_BASE =
  process.env.MA_CURSOR_API_ENDPOINT?.replace(/\/$/, "") ?? "https://api2.cursor.sh"

/** AgentService base (Run, GetUsableModels). CLI GetServerConfig agentn_url. */
export const CURSOR_AGENT_BASE =
  process.env.MA_CURSOR_AGENT_ENDPOINT?.replace(/\/$/, "") ?? "https://agentn.global.api5.cursor.sh"

/** Website origin for loginDeepControl URLs. */
export const CURSOR_WEBSITE_URL =
  process.env.MA_CURSOR_WEBSITE_URL?.replace(/\/$/, "") ?? "https://cursor.com"

/** Connect unary content-type. */
export const CURSOR_UNARY_CONTENT_TYPE = "application/proto"

/** Connect streaming content-type (AgentService/Run). */
export const CURSOR_STREAM_CONTENT_TYPE = "application/connect+proto"

/** Connect protocol version header value. */
export const CURSOR_CONNECT_PROTOCOL_VERSION = "1"

/**
 * User-Agent accepted by Cursor's Connect stack in the spike.
 * Prefer this over inventing a new UA until server acceptance is confirmed.
 */
export const CURSOR_USER_AGENT = "connect-es/1.6.1"

/** Client type advertised to Cursor for MA sessions. */
export const CURSOR_CLIENT_TYPE = "cli"

/** Ghost mode default (no remote indexing / privacy-friendly). */
export const CURSOR_GHOST_MODE_DEFAULT = process.env.MA_CURSOR_GHOST_MODE !== "false"

/** Surface id for the AgentService/Run adapter path. */
export const CURSOR_SURFACE_AGENT_RUN = "cursor-agent-run"

/** AiService AvailableModels RPC path. */
export const CURSOR_RPC_AVAILABLE_MODELS = "aiserver.v1.AiService/AvailableModels"

/** ServerConfigService GetServerConfig (agent URL overlay). */
export const CURSOR_RPC_GET_SERVER_CONFIG = "aiserver.v1.ServerConfigService/GetServerConfig"

/** DashboardService GetCurrentPeriodUsage (included spend + on-demand cap). */
export const CURSOR_RPC_GET_CURRENT_PERIOD_USAGE =
  "aiserver.v1.DashboardService/GetCurrentPeriodUsage"

/** Legacy per-model request buckets (Enterprise fallback). */
export const CURSOR_AUTH_USAGE_PATH = "/auth/usage"

/** AgentService GetUsableModels RPC path. */
export const CURSOR_RPC_GET_USABLE_MODELS = "agent.v1.AgentService/GetUsableModels"

/** AgentService Run (bidi stream; MVP uses unary request body + response stream). */
export const CURSOR_RPC_AGENT_RUN = "agent.v1.AgentService/Run"

/** Auth: exchange user API key for access token. */
export const CURSOR_RPC_EXCHANGE_API_KEY_PATH = "/auth/exchange_user_api_key"

/** Auth: device-code style poll. */
export const CURSOR_AUTH_POLL_PATH = "/auth/poll"

/**
 * Value for `x-cursor-client-version`. Must look like a real Cursor Agent CLI
 * stamp (`cli-YYYY.MM.DD-<sha>`). The IDE spike (`3.12.30`) is rejected by the
 * current agent gateway with Connect `resource_exhausted`. Override via
 * `MA_CURSOR_CLIENT_VERSION`. `headers.ts` also detects an installed
 * `cursor-agent` under `~/.local/share/cursor-agent/versions`.
 */
export const CURSOR_CLIENT_VERSION_DEFAULT = "cli-2026.08.11-e8db854"

/** Plugin display version for diagnostics (not the Connect client version). */
export const CURSOR_PLUGIN_VERSION = "0.1.0"
