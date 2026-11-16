/**
 * Anthropic device-id / fingerprint identity — the `metadata.user_id` wire
 * shape the Claude Code CLI sends on every Messages API request.
 *
 * Moved out of core (`src/metadata.ts`) as part of the provider-decoupling
 * effort: the device-id mimicry and the `{device_id, account_uuid, session_id}`
 * JSON construction are Anthropic fingerprint details and belong to this
 * provider plugin, not the neutral harness. The provider-neutral session UUID
 * stays in core (`src/session-id.ts`); callers thread it in via {@link buildMetadata}'s
 * `sessionId` argument rather than this module reaching back into core.
 *
 * user_id construction matches CLI v2.1.87 exactly. The Messages API requires a
 * `metadata.user_id` field; in v2.1.87 it changed from a flat string to a
 * JSON-stringified object:
 *
 * Old format (v2.1.29): `"user_<64hex>_account_<uuid>_session_<uuid>"`
 * New format (v2.1.87): `JSON.stringify({ device_id, account_uuid, session_id })`
 *
 * The construction mirrors `R76()` (cli.pretty.js L777546-777569):
 *
 * ```
 *     function R76() {
 *       let q = {};                        // from CLAUDE_CODE_EXTRA_METADATA env
 *       // ... parse env var into q ...
 *       return {
 *         user_id: p6({                    // p6 = JSON.stringify (L9198-9209)
 *           ...q,                          // extra metadata spread FIRST
 *           device_id: dR(),               // OVERRIDES any q.device_id
 *           account_uuid: y_()?.accountUuid ?? "",
 *           session_id: k8(),              // OVERRIDES any q.session_id
 *         }),
 *       };
 *     }
 * ```
 *
 * The spread order matters: `...q` is spread before the core fields, so
 * CLAUDE_CODE_EXTRA_METADATA can add custom keys but CANNOT override
 * device_id, account_uuid, or session_id. p6() at L9198 is just JSON.stringify
 * with (object, undefined, undefined), producing compact JSON with no
 * whitespace.
 *
 * Verified against captured traffic. A real request body contains, e.g.:
 * `"user_id":"{\"device_id\":\"<64-hex>\",\"account_uuid\":\"<uuid>\",\"session_id\":\"<uuid>\"}"`
 *
 * @module llm/providers/anthropic/identity
 */

import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { resolveAgentHome } from "@minimal-agent/core/plugin-api/utils/agent-paths"

// ---------------------------------------------------------------------------
// Device id (persistent, read from CLI config)
// ---------------------------------------------------------------------------

/**
 * Default path to the CLI's config file.
 *
 * Resolved by `aM()` at L45457-45462:
 *   - If ~/.claude/.config.json exists, use that
 *   - Otherwise: `~/.claude${k61()}.json` (k61 returns "" for standard installs)
 *   - Respects CLAUDE_CONFIG_DIR env override
 *
 * For standard installs this is simply `~/.claude.json`.
 */
const DEFAULT_CONFIG_PATH = join(process.env.HOME ?? "", ".claude.json")

/**
 * Get the device ID (a persistent 64-hex-char string).
 *
 * The CLI generates this in `dR()` at L48036-48047:
 *
 * ```
 *     function dR() {
 *       let q = j8();              // read config
 *       if (q.userID) return q.userID;  // return cached
 *       let K = GP5(32).toString("hex"); // GP5 = randomBytes (L47426)
 *       x8(_ => ({..._, userID: K}));    // persist to config
 *       return K;
 *     }
 * ```
 *
 * So `userID` in ~/.claude.json IS the device_id. It's 32 random bytes
 * encoded as hex = 64 characters, generated once and persisted forever.
 *
 * We read it from the real CLI config so our user_id matches exactly.
 * If ~/.claude.json doesn't exist (e.g. CLI not installed), we fall back
 * to generating and persisting our own in ~/.claude-demo/state.json.
 *
 * Verified: ~/.claude.json contains a `userID` field like
 * `{ "userID": "<64 hex chars>" }`
 * which matches the device_id in captured .node-net-dbg requests.
 *
 * @param configPath - Path to the CLI config to read `userID` from.
 * @returns The 64-hex-char device id.
 */
export function getDeviceId(configPath: string = DEFAULT_CONFIG_PATH): string {
  // Try reading from the real CLI config first
  try {
    const raw = readFileSync(configPath, "utf-8")
    const config = JSON.parse(raw) as { userID?: string }
    if (config.userID && config.userID.length === 64) {
      return config.userID
    }
  } catch {
    // Config doesn't exist or is invalid — fall through to our own state
  }

  // Fallback: generate and persist to our own state file.
  // This path is only hit if the Claude Code CLI has never been installed.
  const stateDir = join(process.env.HOME ?? "", ".claude-demo")
  const statePath = join(stateDir, "state.json")

  try {
    const raw = readFileSync(statePath, "utf-8")
    const state = JSON.parse(raw) as { deviceId?: string }
    if (state.deviceId && state.deviceId.length === 64) {
      return state.deviceId
    }
  } catch {
    // no state file — generate below
  }

  // Generate like the CLI does: randomBytes(32).toString("hex")
  const id = randomBytes(32).toString("hex")
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(statePath, JSON.stringify({ deviceId: id }, null, 2))
  } catch {
    // best effort persistence
  }
  return id
}

// ---------------------------------------------------------------------------
// Extra metadata from env
// ---------------------------------------------------------------------------

/**
 * Load optional extra metadata from the CLAUDE_CODE_EXTRA_METADATA env var.
 *
 * In R76() (L777548-777559), the CLI parses this env var as JSON and spreads
 * it into the user_id object. It must be a JSON object (not array or primitive).
 * If invalid, the CLI logs an error and ignores it. We do the same.
 *
 * The spread happens BEFORE the core fields, so extra metadata cannot
 * override device_id, account_uuid, or session_id.
 *
 * @returns The parsed extra-metadata object, or `{}` when unset/invalid.
 */
export function loadExtraMetadata(): Record<string, unknown> {
  const raw = process.env.CLAUDE_CODE_EXTRA_METADATA
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>
    }
  } catch {
    // invalid JSON — ignore silently (CLI logs an error, we skip it)
  }
  return {}
}

// ---------------------------------------------------------------------------
// buildUserId — pure function, easy to test
// ---------------------------------------------------------------------------

/** Components encoded into Anthropic's metadata user id. */
interface BuildUserIdOptions {
  deviceId: string
  accountUuid: string
  sessionId: string
  extra?: Record<string, unknown>
}

/**
 * Build the user_id string from its components.
 *
 * This is a pure function that mirrors R76()'s core logic:
 * `JSON.stringify({ ...extra, device_id, account_uuid, session_id })`
 *
 * The result is a compact JSON string (no whitespace) because p6() at L9198
 * calls JSON.stringify with no replacer and no space arguments.
 *
 * @param opts - User id components.
 * @returns The compact JSON `user_id` string.
 * @example
 * ```
 *   buildUserId({
 *     deviceId: "<64 hex>",
 *     accountUuid: "<uuid>",
 *     sessionId: "<uuid>",
 *   })
 *   // → '{"device_id":"<64 hex>","account_uuid":"<uuid>","session_id":"<uuid>"}'
 * ```
 */
export function buildUserId(opts: BuildUserIdOptions): string {
  const payload: Record<string, unknown> = {
    ...opts.extra,
    device_id: opts.deviceId,
    account_uuid: opts.accountUuid,
    session_id: opts.sessionId,
  }
  return JSON.stringify(payload)
}

// ---------------------------------------------------------------------------
// buildMetadata — orchestrates everything
// ---------------------------------------------------------------------------

/**
 * Resolved-credential shape this module needs to build metadata. A local
 * structural slice (NOT a core import) so the plugin stays repo-separable:
 * only the account uuid (for OAuth) crosses the boundary.
 */
export interface IdentityAuth {
  type: "api-key" | "oauth"
  accountUuid?: string
}

/**
 * Build the complete `metadata` payload for a Messages API request.
 *
 * Orchestrates {@link getDeviceId} + {@link loadExtraMetadata} to produce the
 * same `{ user_id: "..." }` that R76() returns. The session id is provided by
 * the caller (core owns the per-process UUID via `src/session-id.ts`) rather
 * than imported, keeping this module free of any host dependency.
 *
 * @param auth - The resolved credential (account uuid used for OAuth).
 * @param sessionId - The per-process session UUID (from core).
 * @param configPath - Optional CLI config path override (for `getDeviceId`).
 * @returns The `{ user_id }` metadata object.
 */
export function buildMetadata(
  auth: IdentityAuth,
  sessionId: string,
  configPath?: string,
): { user_id: string } {
  return {
    user_id: buildUserId({
      deviceId: getDeviceId(configPath),
      accountUuid: auth.type === "oauth" && auth.accountUuid ? auth.accountUuid : "",
      sessionId,
      extra: loadExtraMetadata(),
    }),
  }
}

// ---------------------------------------------------------------------------
// OAuth wire metadata.user_id (claude-code 2.1.325 parity)
// ---------------------------------------------------------------------------

/**
 * Where our own device id lives: `<agent home>/state/anthropic/device.json`
 * (`MINIMAL_AGENT_HOME` honored, like every other plugin's state under the
 * agent home). We deliberately do NOT read `~/.claude.json`: the id is ours,
 * so our traffic is not tied to the user's Claude Code install.
 */
export function ownDeviceIdPath(): string {
  return join(resolveAgentHome(), "state", "anthropic", "device.json")
}

let ownDeviceIdCache: { path: string; id: string } | undefined

/**
 * Stable 64-hex device id we own. Same format as CC's `hD()`
 * (CC/chunk-e44qnbvj.mjs 2.1.325: `co=/^[0-9a-f]{64}$/` … `pp(32).toString("hex")`,
 * persisted once as `userID`): 32 random bytes as hex, generated on first use
 * and persisted (mode 0600). If persistence fails the id still stays stable
 * for this process.
 */
export function getOwnDeviceId(pathArg?: string): string {
  // Under a test runner with no explicit path, keep the id in memory so test
  // runs never write the agent home. Same check as core canonical-send.ts
  // (bun sets BUN_ENV / NODE_ENV to "test"). The plugin's test preload also
  // points MINIMAL_AGENT_HOME at a temp dir (./test-setup.ts).
  const isTest = process.env.BUN_ENV === "test" || process.env.NODE_ENV === "test"
  const ephemeral = pathArg === undefined && isTest
  const path = pathArg ?? ownDeviceIdPath()
  if (ownDeviceIdCache?.path === path) return ownDeviceIdCache.id
  if (ephemeral) {
    ownDeviceIdCache = { path, id: randomBytes(32).toString("hex") }
    return ownDeviceIdCache.id
  }
  let id = readDeviceIdFile(path)
  if (!id) {
    const fresh = randomBytes(32).toString("hex")
    id = fresh
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      // Exclusive create ("wx"): two processes racing on first use cannot both
      // write. The loser gets EEXIST and adopts the winner's id.
      writeFileSync(path, `${JSON.stringify({ deviceId: fresh }, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
        id = readDeviceIdFile(path) ?? fresh
      }
      // Any other error: best effort persistence; the id stays stable for
      // this process through the cache below.
    }
  }
  ownDeviceIdCache = { path, id }
  return id
}

/** The valid 64-hex `deviceId` in `path`, or undefined (missing / malformed). */
function readDeviceIdFile(path: string): string | undefined {
  try {
    const state = JSON.parse(readFileSync(path, "utf-8")) as { deviceId?: unknown }
    if (typeof state.deviceId === "string" && /^[0-9a-f]{64}$/.test(state.deviceId)) {
      return state.deviceId
    }
  } catch {
    // missing or malformed
  }
  return undefined
}

let knownAccountUuid: string | undefined

/**
 * Account uuid per OAuth access token, seeded from the stored credential
 * (`secrets.accountUuid`, the same value `auth-status` shows as `account:`)
 * when core reads it through `readAnthropicOAuthAuth`. Keyed by token so a
 * process that lists several credentials still maps each request to its own
 * account. Bounded: tokens rotate on refresh.
 */
const accountByToken = new Map<string, string>()
const ACCOUNT_BY_TOKEN_MAX = 32

/** Record the stored credential's account uuid for its access token. */
export function rememberCredentialAccount(token: string, uuid: string | undefined): void {
  if (!token || typeof uuid !== "string" || uuid.length === 0) return
  if (accountByToken.size >= ACCOUNT_BY_TOKEN_MAX && !accountByToken.has(token)) {
    accountByToken.clear()
  }
  accountByToken.set(token, uuid)
}

/**
 * Account uuid for an OAuth request: the probe-learned uuid (bootstrap /
 * profile) wins, else the stored credential's uuid for this token.
 */
export function accountUuidFor(token?: string): string | undefined {
  return knownAccountUuid ?? (token ? accountByToken.get(token) : undefined)
}

/**
 * Remember the OAuth account uuid once a startup probe learns it
 * (`/api/claude_cli/bootstrap` `oauth_account.account_uuid`, or the OAuth
 * profile `account.uuid`). The auth seam (`ProviderAuth`) carries no account id.
 */
export function rememberAccountUuid(uuid: string | undefined | null): void {
  if (typeof uuid === "string" && uuid.length > 0) knownAccountUuid = uuid
}

/** Test seam: forget the account uuid and the device-id cache. */
export function _resetIdentityForTest(): void {
  knownAccountUuid = undefined
  ownDeviceIdCache = undefined
  accountByToken.clear()
}

/**
 * CC 2.1.325 `metadata.user_id` for an OAuth request. CC's `Cqe()`
 * (CC/chunk-gpympest.mjs) builds
 * `x={device_id:hD(),account_uuid:…||dT()?.accountUuid||hn()?.accountUuid||"",session_id:G()}`
 * and returns `{user_id:_(h)}` (`_` = JSON.stringify): key order device_id,
 * account_uuid, session_id; an unknown account is `""` (key kept). The D
 * capture body shows the same shape:
 * `"metadata":{"user_id":"{\"device_id\":\"<64hex>\",\"account_uuid\":\"<uuid>\",\"session_id\":\"<uuid>\"}"}`
 * (.node-net-dbg/1794801546609-…/2026-11-16T03-59-10-571-fetch-005-02-req-body.txt).
 * `session_id` is the same id we send as `x-claude-code-session-id`.
 * CLAUDE_CODE_EXTRA_METADATA and CC's sub-agent `parent_session_id` are not
 * mirrored.
 */
export function buildOAuthMetadata(
  sessionId: string,
  deviceIdPath?: string,
  token?: string,
): { user_id: string } {
  return {
    user_id: buildUserId({
      deviceId: getOwnDeviceId(deviceIdPath),
      accountUuid: accountUuidFor(token) ?? "",
      sessionId,
    }),
  }
}
