#!/usr/bin/env bun
/**
 * Control CLI for the ComputerUseHelper daemon (one Swift Mach-O binary).
 *
 *   cud build           compile native/build/ComputerUseHelper with swiftc, run --selftest
 *   cud notarize        legacy, opt-in: Release .app + Developer ID sign + notarize
 *   cud start           launch the helper binary as a detached daemon
 *   cud stop            terminate the daemon
 *   cud restart         stop + start (needed after a permission grant)
 *   cud status          report running + ping the socket
 *   cud logs [N]        tail the daemon log
 *   cud perms           print permission status (runs the binary --check)
 *   cud prompt          fire permission prompts + open Settings (runs --prompt)
 *   cud disable         set the kill switch (daemon refuses mutating actions)
 *   cud enable          clear the kill switch
 *
 * Mirrors ma-chrome-cdp-plugin/bin/cdpd.ts. `build` uses plain `swiftc` and keeps
 * the ad-hoc signature of the linker. It signs only when `MA_CU_SIGN_IDENTITY`
 * is set. It never reads the keychain for an identity. macOS gives the
 * Accessibility and Screen Recording grants of the terminal app that starts the
 * helper, so the helper signature does not change the grants.
 *
 * @module bin/cud
 */

import { spawn, spawnSync } from "node:child_process"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  disabledFlagPath,
  helperApp,
  helperBinary,
  logPath,
  socketPath,
  supportDir,
} from "../lib/paths.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = dirname(HERE)
const NATIVE_DIR = `${PACKAGE_DIR}/native`
const SOCK = socketPath()
const LOG = logPath()

/**
 * Signing values for xcodegen (`${MA_CU_*}` in native/project.yml), used only by
 * the legacy `notarize` command. Placeholder defaults.
 */
function signingEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MA_CU_TEAM_ID: process.env.MA_CU_TEAM_ID ?? "TEAMID0000",
    MA_CU_BUNDLE_ID: process.env.MA_CU_BUNDLE_ID ?? "dev.example.computeruse",
  }
}
const BIN = helperBinary(PACKAGE_DIR)
const APP = helperApp(PACKAGE_DIR)
/** Output of `cud build`: one Mach-O file. The name keeps `pgrep -f ComputerUseHelper` working. */
const BUILD_BIN = join(NATIVE_DIR, "build", "ComputerUseHelper")

/** The `swiftc` target arch for this machine. */
function swiftArch(): string {
  return process.arch === "x64" ? "x86_64" : "arm64"
}

/** Every `.swift` file in native/Sources, sorted, as full paths. */
function swiftSources(): string[] {
  const dir = join(NATIVE_DIR, "Sources")
  return readdirSync(dir)
    .filter((f) => f.endsWith(".swift"))
    .sort()
    .map((f) => join(dir, f))
}

/**
 * Compile the helper with plain `swiftc`, the same way on a dev Mac and on CI.
 * The linker gives an ad-hoc signature. Sign again only when
 * `MA_CU_SIGN_IDENTITY` is set and not empty. Then run `--selftest` and print
 * the signature.
 */
function build(): void {
  mkdirSync(join(NATIVE_DIR, "build"), { recursive: true })
  const sources = swiftSources()
  const target = `${swiftArch()}-apple-macos14`
  console.log(`Compiling ${sources.length} Swift files (swiftc, ${target})...`)
  const cc = spawnSync(
    "swiftc",
    ["-O", "-target", target, "-module-name", "ComputerUseHelper", ...sources, "-o", BUILD_BIN],
    { cwd: NATIVE_DIR, stdio: "inherit" },
  )
  if (cc.status !== 0) {
    console.error("swiftc failed")
    process.exit(cc.status ?? 1)
  }

  const identity = process.env.MA_CU_SIGN_IDENTITY ?? ""
  if (identity !== "") {
    console.log(`Signing with MA_CU_SIGN_IDENTITY: ${identity}`)
    const sign = spawnSync(
      "codesign",
      ["--force", "--options", "runtime", "--sign", identity, BUILD_BIN],
      { stdio: "inherit" },
    )
    if (sign.status !== 0) {
      console.error("codesign failed")
      process.exit(sign.status ?? 1)
    }
  } else {
    console.log("No MA_CU_SIGN_IDENTITY: keeping the linker ad-hoc signature.")
  }

  console.log("Running --selftest...")
  const st = spawnSync(BUILD_BIN, ["--selftest"], { stdio: "inherit" })
  if (st.status !== 0) {
    console.error("selftest failed")
    process.exit(st.status ?? 1)
  }

  console.log(`\nBuilt: ${BUILD_BIN}`)
  spawnSync("codesign", ["-dv", "--verbose=2", BUILD_BIN], { stdio: "inherit" })
  spawnSync("codesign", ["-d", "-r-", BUILD_BIN], { stdio: "inherit" })
}

function running(): boolean {
  const r = spawnSync("pgrep", ["-f", "ComputerUseHelper"], { encoding: "utf8" })
  return r.status === 0 && r.stdout.trim().length > 0
}

async function ping(): Promise<unknown> {
  try {
    const res = await fetch("http://localhost/ping", {
      unix: SOCK,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    } as RequestInit & { unix: string })
    return await res.json()
  } catch {
    return null
  }
}

function ensureDirs(): void {
  mkdirSync(supportDir(), { recursive: true })
  mkdirSync(dirname(LOG), { recursive: true })
}

function startDaemon(): void {
  if (!existsSync(BIN)) {
    console.error(`helper binary not found at ${BIN}\nRun: bun run bin/cud.ts build`)
    process.exit(1)
  }
  ensureDirs()
  let logFd: number | undefined
  try {
    logFd = openSync(LOG, "a")
  } catch {
    logFd = undefined
  }
  const child = spawn(BIN, [], {
    detached: true,
    stdio: logFd === undefined ? "ignore" : ["ignore", logFd, logFd],
    env: process.env,
  })
  child.unref()
  if (logFd !== undefined) closeSync(logFd)
}

const cmd = process.argv[2] ?? ""

switch (cmd) {
  case "build": {
    build()
    break
  }
  case "notarize": {
    // Legacy and opt-in: `build` does not use it. It needs xcodegen + xcodebuild,
    // makes the Release .app (no get-task-allow), then Developer ID sign +
    // notarytool + staple. Reads notary creds from the private env file (see
    // sign-and-notarize.sh).
    console.log("Generating Xcode project (xcodegen)…")
    if (
      spawnSync("xcodegen", ["generate"], { cwd: NATIVE_DIR, stdio: "inherit", env: signingEnv() })
        .status !== 0
    ) {
      console.error("xcodegen failed")
      process.exit(1)
    }
    console.log("Building Release (unsigned; the script re-signs with Developer ID)…")
    const rb = spawnSync(
      "xcodebuild",
      [
        "-project",
        "ComputerUseHelper.xcodeproj",
        "-scheme",
        "ComputerUseHelper",
        "-configuration",
        "Release",
        "-derivedDataPath",
        "build/DerivedData",
        `CONFIGURATION_BUILD_DIR=${NATIVE_DIR}/build`,
        "CODE_SIGNING_ALLOWED=NO",
        "build",
      ],
      { cwd: NATIVE_DIR, stdio: "inherit" },
    )
    if (rb.status !== 0) {
      console.error("Release build failed")
      process.exit(rb.status ?? 1)
    }
    const script = `${NATIVE_DIR}/sign-and-notarize.sh`
    const credsArg = process.argv[3] // optional override path to notary-credentials.env
    const sn = spawnSync("bash", credsArg ? [script, APP, credsArg] : [script], {
      cwd: NATIVE_DIR,
      stdio: "inherit",
    })
    if (sn.status !== 0) {
      console.error("sign/notarize/staple failed")
      process.exit(sn.status ?? 1)
    }
    break
  }
  case "start": {
    if (running()) {
      console.log("already running")
      break
    }
    startDaemon()
    await new Promise((r) => setTimeout(r, 1200))
    console.log(running() ? "started" : "failed to start; check logs (cud logs)")
    break
  }
  case "stop": {
    // -x: exact process name, so no other process with this text in its
    // command line gets the signal (review L1).
    spawnSync("pkill", ["-x", "ComputerUseHelper"])
    try {
      rmSync(SOCK)
    } catch {
      // ignore
    }
    console.log("stopped")
    break
  }
  case "restart": {
    spawnSync("pkill", ["-x", "ComputerUseHelper"])
    await new Promise((r) => setTimeout(r, 800))
    startDaemon()
    await new Promise((r) => setTimeout(r, 1200))
    console.log(running() ? "restarted" : "failed to restart; check logs")
    break
  }
  case "status": {
    if (!running()) {
      console.log("not running")
      break
    }
    console.log("running")
    console.log(JSON.stringify(await ping(), null, 2))
    break
  }
  case "logs": {
    if (existsSync(LOG))
      spawnSync("tail", ["-n", process.argv[3] ?? "40", LOG], { stdio: "inherit" })
    else console.log("(no log yet)")
    break
  }
  case "perms": {
    if (!existsSync(BIN)) {
      console.error(`helper not built. Run: bun run bin/cud.ts build`)
      process.exit(1)
    }
    spawnSync(BIN, ["--check"], { stdio: "inherit" })
    break
  }
  case "prompt": {
    if (!existsSync(BIN)) {
      console.error(`helper not built. Run: bun run bin/cud.ts build`)
      process.exit(1)
    }
    spawnSync(BIN, ["--prompt"], { stdio: "inherit" })
    break
  }
  case "disable": {
    ensureDirs()
    writeFileSync(disabledFlagPath(), `disabled ${new Date().toISOString()}\n`)
    console.log("kill switch ON (mutating actions refused). Run: cud enable to clear.")
    break
  }
  case "enable": {
    try {
      rmSync(disabledFlagPath())
    } catch {
      // ignore
    }
    console.log("kill switch OFF")
    break
  }
  default:
    console.log(
      "usage: cud {build|notarize|start|stop|restart|status|logs [N]|perms|prompt|disable|enable}\n" +
        "  build     swiftc -> native/build/ComputerUseHelper (ad-hoc, sign only if MA_CU_SIGN_IDENTITY is set)\n" +
        "  notarize  legacy, opt-in: Release .app + Developer ID + notarytool",
    )
    process.exit(2)
}
