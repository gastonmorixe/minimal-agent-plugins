/**
 * Shared helpers for the `@minimal-agent/core` git pin.
 *
 * The root package.json and many plugin package.json files name core as a
 * git dependency with a commit SHA after `#`. All of them must use the same
 * full 40-char SHA. `pin-core.ts` writes the pin. `core-pin.test.ts` checks it.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** Package name of core. */
export const CORE_NAME = "@minimal-agent/core"

/** Git URL of core, without the `#ref` part. */
export const CORE_URL = "git+ssh://git@github.com/gastonmorixe/minimal-agent-core.git"

/** package.json fields that can name core. */
export const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const

/** A full git commit SHA: 40 lowercase hex chars. */
export const FULL_SHA = /^[0-9a-f]{40}$/

/** One core reference found in a file. */
export type CorePin = {
  /** Repo-relative file path. */
  file: string
  /** Where in the file (package.json field, or bun.lock line). */
  where: string
  /** The full value that names core. */
  value: string
  /** The ref after `#`, or "" when the value has no `#`. */
  ref: string
}

/** Return the ref after `#` in a core git URL, or "" when there is none. */
export function refOf(value: string): string {
  const hash = value.lastIndexOf("#")
  return hash === -1 ? "" : value.slice(hash + 1)
}

/** List every package.json in the repo (root first), outside node_modules. */
export function listPackageJsons(root: string): string[] {
  const glob = new Bun.Glob("**/package.json")
  const out: string[] = []
  for (const path of glob.scanSync({ cwd: root, onlyFiles: true })) {
    if (path.split("/").includes("node_modules")) continue
    out.push(path)
  }
  return out.sort((a, b) =>
    a === "package.json" ? -1 : b === "package.json" ? 1 : a.localeCompare(b),
  )
}

/** Return every core reference in one package.json text. */
export function pinsInPackageJson(file: string, text: string): CorePin[] {
  const json: unknown = JSON.parse(text)
  if (typeof json !== "object" || json === null) return []
  const record = json as Record<string, unknown>
  const pins: CorePin[] = []
  for (const field of DEP_FIELDS) {
    const deps = record[field]
    if (typeof deps !== "object" || deps === null) continue
    const value = (deps as Record<string, unknown>)[CORE_NAME]
    if (typeof value !== "string") continue
    pins.push({ file, where: field, value, ref: refOf(value) })
  }
  return pins
}

/**
 * Return every core reference in a bun.lock text.
 *
 * It finds each core git URL with its `#ref`. It also finds the resolved SHA
 * that bun writes as the last item of the core package entry.
 */
export function pinsInBunLock(file: string, text: string): CorePin[] {
  const pins: CorePin[] = []
  const lines = text.split("\n")
  for (const [index, line] of lines.entries()) {
    if (!line.includes("minimal-agent-core")) continue
    const where = `line ${index + 1}`
    for (const match of line.matchAll(/[^"\s]*minimal-agent-core[^"\s]*/g)) {
      pins.push({ file, where, value: match[0], ref: refOf(match[0]) })
    }
    const resolved = line.match(/^\s*"@minimal-agent\/core":\s*\[.*,\s*"([^"]*)"\],?\s*$/)
    if (resolved?.[1] !== undefined) {
      pins.push({ file, where: `${where} (resolved)`, value: resolved[1], ref: resolved[1] })
    }
  }
  return pins
}

/** Return every core reference in the repo package.json files and bun.lock. */
export function collectPins(root: string): CorePin[] {
  const pins: CorePin[] = []
  for (const file of listPackageJsons(root)) {
    pins.push(...pinsInPackageJson(file, readFileSync(join(root, file), "utf8")))
  }
  const lock = join(root, "bun.lock")
  if (existsSync(lock)) pins.push(...pinsInBunLock("bun.lock", readFileSync(lock, "utf8")))
  return pins
}

/**
 * Return one problem line for each pin that is not a full SHA or that does
 * not match `expected`. An empty list means every pin is good.
 */
export function pinProblems(pins: CorePin[], expected: string): string[] {
  const problems: string[] = []
  for (const pin of pins) {
    if (!FULL_SHA.test(pin.ref)) {
      problems.push(`${pin.file} ${pin.where}: ref "${pin.ref}" is not a 40-char SHA`)
    } else if (pin.ref !== expected) {
      problems.push(`${pin.file} ${pin.where}: ${pin.ref} != ${expected}`)
    }
  }
  return problems
}

/** Return the core SHA in the root package.json `dependencies`. */
export function rootPin(root: string): string {
  const text = readFileSync(join(root, "package.json"), "utf8")
  const pin = pinsInPackageJson("package.json", text).find((p) => p.where === "dependencies")
  if (pin === undefined) throw new Error(`root package.json has no ${CORE_NAME} dependency`)
  return pin.ref
}

/**
 * Set the core ref to `sha` in every dep field of one package.json text.
 * It edits only the value string, so the file keeps its format.
 */
export function repinText(text: string, sha: string): string {
  let out = text
  for (const pin of pinsInPackageJson("", text)) {
    const next = `${CORE_URL}#${sha}`
    if (pin.value === next) continue
    out = out.replaceAll(JSON.stringify(pin.value), JSON.stringify(next))
  }
  return out
}
