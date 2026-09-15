/**
 * Login orchestration — ties the device grant (`lib/auth.ts`) to local token
 * persistence (`lib/token-store.ts`).
 *
 * A CLI device login is two-phase by nature: phase 1 returns a user_code + URL
 * the human must visit, phase 2 polls in the background until they approve. The
 * tool handler can't block for minutes, so this exposes BOTH a one-shot
 * {@link beginLogin} (returns the code to show the user) and a {@link completeLogin}
 * (polls to completion + persists), plus a convenience {@link runLogin} for tests
 * / non-interactive use that does both.
 *
 * Config (endpoint, client id, scope) is read from the environment so the user /
 * host controls it without code changes.
 *
 * @module lib/login
 */

import {
  type AuthIo,
  type AuthResult,
  type DeviceCodeResponse,
  type DeviceToken,
  defaultAuthIo,
  pollForToken,
  requestDeviceCode,
} from "./auth.ts"
import { type StoredAuth, saveAuth } from "./token-store.ts"

/** Resolved cloud connection config, from env with sane local-dev defaults. */
export interface CloudConfig {
  /** Auth base URL. `MINIMAL_AGENT_CLOUD_URL`, default local dev api. */
  readonly baseUrl: string
  /** GraphQL endpoint (for the `me` flags query etc). Derived from baseUrl or env override. */
  readonly graphqlUrl: string
  /** OAuth client id. `MINIMAL_AGENT_CLOUD_CLIENT_ID`, default "minimal-agent-cli" (Mike's allowlist target). */
  readonly clientId: string
  /** Requested scope. `MINIMAL_AGENT_CLOUD_SCOPE`, default "teleport remote-peers". */
  readonly scope: string
}

/**
 * Derive the GraphQL URL from the auth base URL: the api serves `/api/auth/*`
 * and `/graphql` as SIBLING routes on the same origin (Mike's B1), so strip the
 * `/api/auth` suffix and append `/graphql`. Overridable via env for non-standard
 * deployments.
 */
function deriveGraphqlUrl(baseUrl: string): string {
  const origin = baseUrl.replace(/\/+$/, "").replace(/\/api\/auth$/, "")
  return `${origin}/graphql`
}

/** Read {@link CloudConfig} from the environment. */
export function cloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const baseUrl = env.MINIMAL_AGENT_CLOUD_URL?.trim() || "http://localhost:4000/api/auth"
  const graphqlUrl = env.MINIMAL_AGENT_CLOUD_GRAPHQL_URL?.trim() || deriveGraphqlUrl(baseUrl)
  const clientId = env.MINIMAL_AGENT_CLOUD_CLIENT_ID?.trim() || "minimal-agent-cli"
  const scope = env.MINIMAL_AGENT_CLOUD_SCOPE?.trim() || "teleport remote-peers"
  return { baseUrl, graphqlUrl, clientId, scope }
}

/** Phase 1: get a device + user code to show the user. */
export function beginLogin(
  cfg: CloudConfig,
  io: AuthIo = defaultAuthIo(),
): Promise<AuthResult<DeviceCodeResponse>> {
  return requestDeviceCode(io, {
    baseUrl: cfg.baseUrl,
    clientId: cfg.clientId,
    ...(cfg.scope ? { scope: cfg.scope } : {}),
  })
}

/** Phase 2: poll until approval, then persist the token. Returns the stored auth. */
export async function completeLogin(
  cfg: CloudConfig,
  code: DeviceCodeResponse,
  env: NodeJS.ProcessEnv = process.env,
  io: AuthIo = defaultAuthIo(),
): Promise<AuthResult<StoredAuth>> {
  const polled = await pollForToken(io, {
    baseUrl: cfg.baseUrl,
    clientId: cfg.clientId,
    ...(cfg.scope ? { scope: cfg.scope } : {}),
    deviceCode: code.device_code,
    interval: code.interval,
    expiresIn: code.expires_in,
  })
  if (!polled.ok) return polled
  return persist(cfg, polled.value, env)
}

/** Persist a {@link DeviceToken} as {@link StoredAuth}. */
function persist(
  cfg: CloudConfig,
  token: DeviceToken,
  env: NodeJS.ProcessEnv,
): AuthResult<StoredAuth> {
  const stored: StoredAuth = {
    v: 1,
    accessToken: token.accessToken,
    baseUrl: cfg.baseUrl,
    obtainedAt: token.obtainedAt,
    ...(token.userId ? { userId: token.userId } : {}),
  }
  const saved = saveAuth(stored, env)
  if (!saved.ok) return { ok: false, reason: `token obtained but not saved: ${saved.reason}` }
  return { ok: true, value: stored }
}

/**
 * Convenience: run the whole flow (begin → poll → persist) in one call. Used by
 * tests (with mocked IO) and any non-interactive caller. An interactive tool uses
 * {@link beginLogin} + {@link completeLogin} so it can show the code first.
 */
export async function runLogin(
  cfg: CloudConfig,
  env: NodeJS.ProcessEnv = process.env,
  io: AuthIo = defaultAuthIo(),
): Promise<AuthResult<StoredAuth>> {
  const begun = await beginLogin(cfg, io)
  if (!begun.ok) return begun
  return completeLogin(cfg, begun.value, env, io)
}
