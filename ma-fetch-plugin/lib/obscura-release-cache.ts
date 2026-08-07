/**
 * Durable stale-while-revalidate cache for the resolved obscura release.
 *
 * Resolving the rolling release requires GitHub API calls. The Fetch setup hook
 * must not put those calls on every interactive startup once a usable release
 * is known, so this module stores only the verified install coordinates and
 * their last successful check time.
 *
 * @module lib/obscura-release-cache
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { type ResolvedObscuraBuild, targetForPlatform } from "./resolve-obscura-release.ts"

/** Refresh a release record at most once per six hours for a given installation. */
export const OBSCURA_RELEASE_CACHE_TTL_MS = 6 * 60 * 60 * 1000

const CACHE_SCHEMA_VERSION = 1

export interface CachedObscuraRelease extends ResolvedObscuraBuild {
  /** Epoch milliseconds when these coordinates last resolved successfully. */
  checkedAt: number
}

/** Return the canonical cache location under the host-owned agent home. */
export function obscuraReleaseCachePath(agentHome: string, platform: string): string {
  return join(agentHome, "cache", "ma-fetch", `obscura-release-${platform}.json`)
}

/**
 * Read a valid cached release record. Corrupt, incompatible, or incomplete
 * records are treated as absent; a setup cache must never make boot fail.
 */
export function readCachedObscuraRelease(path: string): CachedObscuraRelease | null {
  try {
    if (!existsSync(path)) return null
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!parsed || typeof parsed !== "object") return null
    const value = parsed as Record<string, unknown>
    if (value.schemaVersion !== CACHE_SCHEMA_VERSION) return null
    if (
      typeof value.checkedAt !== "number" ||
      !Number.isFinite(value.checkedAt) ||
      typeof value.version !== "string" ||
      !/^\d+$/.test(value.version) ||
      typeof value.tag !== "string" ||
      value.tag.length === 0 ||
      typeof value.asset !== "string" ||
      !/^obscura-[a-z0-9_]+-[a-z0-9]+-\d+\.tar\.gz$/.test(value.asset) ||
      typeof value.sha256 !== "string" ||
      typeof value.platform !== "string" ||
      targetForPlatform(value.platform) === undefined ||
      !value.asset.includes(`-${value.version}.tar.gz`) ||
      !/^[0-9a-f]{64}$/i.test(value.sha256)
    ) {
      return null
    }
    return {
      checkedAt: value.checkedAt,
      version: value.version,
      tag: value.tag,
      asset: value.asset,
      sha256: value.sha256.toLowerCase(),
      platform: value.platform,
    }
  } catch {
    return null
  }
}

/** True when a cached record remains inside its refresh interval. */
export function isCachedObscuraReleaseFresh(
  cached: CachedObscuraRelease,
  now: number = Date.now(),
  ttlMs: number = OBSCURA_RELEASE_CACHE_TTL_MS,
): boolean {
  return now - cached.checkedAt < ttlMs
}

/**
 * Atomically write the last-known-good release coordinates. A write failure is
 * deliberately non-fatal: the resolved build is still valid for this boot.
 */
export function writeCachedObscuraRelease(
  path: string,
  build: ResolvedObscuraBuild,
  now: number = Date.now(),
): void {
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      temporary,
      `${JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, checkedAt: now, ...build })}\n`,
      "utf8",
    )
    renameSync(temporary, path)
  } catch {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Best effort only.
    }
  }
}
