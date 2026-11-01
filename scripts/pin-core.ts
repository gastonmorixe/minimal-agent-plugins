/**
 * Pin `@minimal-agent/core` to one git SHA in every package.json.
 *
 * Usage: `bun run pin:core [<40-char sha>]`. With no SHA, it uses the
 * current core `main` from `git ls-remote`. It edits the root package.json
 * and every plugin package.json (dependencies, devDependencies,
 * peerDependencies, optionalDependencies). It shows the old and new SHA
 * per file, then runs `bun install` to update bun.lock.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { FULL_SHA, listPackageJsons, pinsInPackageJson, repinText } from "./core-pin.ts"

const REPO_ROOT = join(import.meta.dir, "..")
const CORE_REMOTE = "https://github.com/gastonmorixe/minimal-agent-core.git"

function coreMainSha(): string {
  const result = Bun.spawnSync(["git", "ls-remote", CORE_REMOTE, "refs/heads/main"])
  const out = result.stdout.toString().trim()
  if (result.exitCode !== 0 || out === "") {
    throw new Error(`git ls-remote failed: ${result.stderr.toString().trim()}`)
  }
  return out.split(/\s+/)[0] ?? ""
}

const sha = process.argv[2] ?? coreMainSha()
if (!FULL_SHA.test(sha)) {
  console.error(`pin:core: "${sha}" is not a 40-char lowercase SHA`)
  process.exit(1)
}

console.log(`pin:core: target ${sha}`)
let changed = 0
for (const file of listPackageJsons(REPO_ROOT)) {
  const path = join(REPO_ROOT, file)
  const text = readFileSync(path, "utf8")
  const pins = pinsInPackageJson(file, text)
  if (pins.length === 0) continue
  const next = repinText(text, sha)
  for (const pin of pins) {
    const mark = pin.ref === sha ? "(same)" : `${pin.ref || "(none)"} -> ${sha}`
    console.log(`  ${file} ${pin.where}: ${mark}`)
  }
  if (next !== text) {
    writeFileSync(path, next)
    changed++
  }
}
console.log(`pin:core: ${changed} file(s) changed`)

console.log("pin:core: bun install")
const install = Bun.spawnSync(["bun", "install"], {
  cwd: REPO_ROOT,
  stdout: "inherit",
  stderr: "inherit",
})
process.exit(install.exitCode ?? 1)
