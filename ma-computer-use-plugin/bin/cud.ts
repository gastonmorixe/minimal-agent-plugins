#!/usr/bin/env bun
/**
 * Control CLI for the ComputerUseHelper daemon (the signed Swift .app).
 *
 *   cud build           build + sign the .app (xcodegen + xcodebuild)
 *   cud start           launch the signed .app as a detached daemon
 *   cud stop            terminate the daemon
 *   cud restart         stop + start (needed after granting TCC)
 *   cud status          report running + ping the socket
 *   cud logs [N]        tail the daemon log
 *   cud perms           print permission status (runs the .app --check)
 *   cud prompt          fire permission prompts + open Settings (runs --prompt)
 *   cud disable         set the kill switch (daemon refuses mutating actions)
 *   cud enable          clear the kill switch
 *
 * Mirrors ma-chrome-cdp-plugin/bin/cdpd.ts. The daemon is the .app binary, exec'd
 * directly so TCC attributes grants to ComputerUseHelper.app (not bun).
 *
 * @module bin/cud
 */

import { spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
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
const BIN = helperBinary(PACKAGE_DIR)
const APP = helperApp(PACKAGE_DIR)

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
    console.log("Generating Xcode project (xcodegen)…")
    const gen = spawnSync("xcodegen", ["generate"], { cwd: NATIVE_DIR, stdio: "inherit" })
    if (gen.status !== 0) {
      console.error("xcodegen failed")
      process.exit(gen.status ?? 1)
    }
    console.log("Building + signing (xcodebuild)…")
    const build = spawnSync(
      "xcodebuild",
      [
        "-project",
        "ComputerUseHelper.xcodeproj",
        "-scheme",
        "ComputerUseHelper",
        "-configuration",
        "Debug",
        "-derivedDataPath",
        "build/DerivedData",
        `CONFIGURATION_BUILD_DIR=${NATIVE_DIR}/build`,
        "build",
      ],
      { cwd: NATIVE_DIR, stdio: "inherit" },
    )
    if (build.status !== 0) {
      console.error("xcodebuild failed")
      process.exit(build.status ?? 1)
    }
    console.log(`\nBuilt: ${APP}`)
    spawnSync("codesign", ["-dv", "--verbose=2", APP], { stdio: "inherit" })
    break
  }
  case "notarize": {
    // Release build (no get-task-allow) + Developer ID sign + notarytool + staple.
    // Reads notary creds from the private env file (see sign-and-notarize.sh).
    console.log("Generating Xcode project (xcodegen)…")
    if (spawnSync("xcodegen", ["generate"], { cwd: NATIVE_DIR, stdio: "inherit" }).status !== 0) {
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
    spawnSync("pkill", ["-f", "ComputerUseHelper"])
    try {
      rmSync(SOCK)
    } catch {
      // ignore
    }
    console.log("stopped")
    break
  }
  case "restart": {
    spawnSync("pkill", ["-f", "ComputerUseHelper"])
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
      "usage: cud {build|notarize|start|stop|restart|status|logs [N]|perms|prompt|disable|enable}",
    )
    process.exit(2)
}
