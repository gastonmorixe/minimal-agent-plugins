/**
 * A stale credential name: the lead has it, the auth store does not.
 *
 * A worker gets the credential name of the lead (`--credential-name`). When
 * the user logs out and in again, the auth store can delete that name and
 * make new names, but the live target of the lead keeps the old name. The
 * worker then stops at boot. Its stderr log has the real cause:
 *
 *   fatal: no usable credential "anthropic-plan-oauth-2" for provider "anthropic"
 *
 * But the stream text of an older CLI says only "no credentials for provider",
 * and that text is not correct when the store holds other credentials.
 *
 * The plugin API gives no list of stored credential names, so the plugin
 * cannot see a stale name before the first spawn. This module does the two
 * steps that the plugin can do:
 *
 * 1. At the failure: find the stale name (in the failure text, else in the
 *    log) and make a fleet reason that names it.
 * 2. At the next spawn: find that reason in the fleet, and do not give the
 *    same inherited name to the new worker. It uses the provider default.
 *
 * @module sub-agents/lib/stale-credential
 */

import type { PromptRender } from "./prompts.ts"
import type { SubagentRecord } from "./types.ts"

/** The env key in which the lead publishes its credential name. A worker inherits it. */
export const ENV_CREDENTIAL_NAME = "MINIMAL_AGENT_CREDENTIAL_NAME"

/** One id in the JSON quotes of the CLI (`quotedId`). */
const QUOTED = String.raw`("(?:[^"\\]|\\.)*")`

/** The CLI summary for a named credential. */
const NAMED = new RegExp(`no usable credential ${QUOTED} for provider ${QUOTED}`)

/** A credential failure that names no credential (the stream text of an older CLI). */
const UNNAMED = /\bno (?:usable )?credentials? for provider\b/i

/** The start of the fleet reason that {@link staleCredentialReason} makes. */
const REASON = new RegExp(`^credential ${QUOTED} is not stored any more \\(provider ${QUOTED}\\)`)

/** A credential name that a worker could not use, and its provider. */
export interface StaleCredential {
  readonly name: string
  readonly provider: string
}

/** Parse one JSON-quoted id, or `undefined` when it is not a JSON string. */
function unquote(quoted: string | undefined): string | undefined {
  if (quoted === undefined) return undefined
  try {
    const value: unknown = JSON.parse(quoted)
    return typeof value === "string" ? value : undefined
  } catch {
    return undefined
  }
}

/** The name and the provider in the 2 groups of `m`, or `undefined`. */
function fromMatch(m: RegExpExecArray | null): StaleCredential | undefined {
  const name = unquote(m?.[1])
  const provider = unquote(m?.[2])
  return name !== undefined && provider !== undefined ? { name, provider } : undefined
}

/** The stale credential that a CLI failure text names, or `undefined`. */
export function findStaleCredential(text: string): StaleCredential | undefined {
  return fromMatch(NAMED.exec(text))
}

/**
 * The fleet failure reason for a stale credential. The lead digest clips the
 * reason at 160 characters, so the name and the next step come first.
 */
export function staleCredentialReason(c: StaleCredential): string {
  const provider = JSON.stringify(c.provider)
  return (
    `credential ${JSON.stringify(c.name)} is not stored any more (provider ${provider}). ` +
    `Spawn again: the next worker uses the default ${provider} credential.`
  )
}

/**
 * Return `failure` with the stale credential named, or `failure` with no change.
 *
 * @param failure - The failure text from the stream or the log.
 * @param readLog - Gives the crash line of the worker log. Called only for a
 *   credential failure whose own text names no credential.
 */
export function nameStaleCredential(failure: string, readLog: () => string | undefined): string {
  const direct = findStaleCredential(failure)
  if (direct) return staleCredentialReason(direct)
  if (!UNNAMED.test(failure)) return failure
  const fromLog = findStaleCredential(readLog() ?? "")
  return fromLog ? staleCredentialReason(fromLog) : failure
}

/**
 * The stale credential when a failed worker of this fleet showed that `name`
 * is not stored for `provider`, else `undefined`. An unknown `provider`
 * matches on the name only. If a later worker succeeded (`done`) without
 * falling back from that credential (e.g. the user re-added the credential),
 * the earlier failure is considered superseded.
 */
export function findKnownStale(
  records: readonly SubagentRecord[],
  name: string,
  provider: string | undefined,
): StaleCredential | undefined {
  let latestStale: StaleCredential | undefined
  for (const r of records) {
    if (r.status.kind === "failed") {
      const stale = fromMatch(REASON.exec(r.status.error))
      if (stale?.name === name && (!provider || stale.provider === provider)) {
        latestStale = stale
      }
      continue
    }
    if (latestStale && r.status.kind === "done") {
      const fellBack =
        r.credentialFallback?.from === name &&
        (!provider || r.credentialFallback.provider === provider)
      const otherProvider =
        provider !== undefined &&
        r.profileProvider?.worker !== undefined &&
        r.profileProvider.worker !== provider
      if (!fellBack && !otherProvider) {
        latestStale = undefined
      }
    }
  }
  return latestStale
}

/**
 * The one-line warning when a worker does not get the stale lead credential.
 * The text is in `prompts/credential-fallback.tmpl.md`.
 */
export function credentialFallbackText(
  c: { readonly from: string; readonly provider: string },
  render: PromptRender,
): string {
  return render("credential-fallback.tmpl.md", { name: c.from, provider: c.provider }).trim()
}
