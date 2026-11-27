/**
 * Tool-call handler for `Computer`.
 *
 * Talks to the ComputerUseHelper daemon over its unix domain socket. If the
 * daemon isn't running it auto-spawns the helper binary, then forwards the
 * validated action and shapes the response into a TUIResult. In a compiled
 * CLI, the handler first extracts the embedded helper to
 * `<packageDir>/native/build/ComputerUseHelper` (lib/embedded-helper.ts), so
 * the normal lookup finds it. macOS gives the
 * helper the Accessibility and Screen Recording grants of the terminal app that
 * runs minimal-agent. The helper signature does not change that.
 *
 * The pure pieces (input validation, response rendering, daemon lifecycle) live
 * in lib/ and are unit-tested. This file is the thin imperative shell. Mirrors
 * ma-chrome-cdp-plugin/handlers/chrome_cdp.ts.
 *
 * @module handlers/computer
 */

import { spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import { dirname } from "node:path"

import {
  ensureDaemon,
  HelperTimeoutError,
  makeBunSocketFetch,
  PING_TIMEOUT_MS,
  parsePing,
  type SocketFetch,
} from "../lib/client.ts"
import { type ExtractResult, extractHelper } from "../lib/embedded-helper.ts"
import { isSourceCheckout, missingHelperText } from "../lib/missing-helper.ts"
import { helperBinary, logPath, socketPath, supportDir } from "../lib/paths.ts"
import { dim, isErrorBody, red, renderContent, summarize } from "../lib/render.ts"
import { validateToolInput } from "../lib/routes.ts"
import type { TUIContext, TUIResult } from "../lib/types.ts"

const SOCK = socketPath()
const LOG = logPath()

/**
 * Spawn the helper binary detached so it outlives this tool call. Its
 * stdout+stderr append to LOG.
 */
function spawnDaemon(packageDir: string): void {
  const bin = helperBinary(packageDir)
  try {
    mkdirSync(supportDir(), { recursive: true })
    mkdirSync(dirname(LOG), { recursive: true })
  } catch {
    // ignore
  }
  let logFd: number | undefined
  try {
    logFd = openSync(LOG, "a")
  } catch {
    logFd = undefined
  }
  const child = spawn(bin, [], {
    detached: true,
    stdio: logFd === undefined ? "ignore" : ["ignore", logFd, logFd],
    env: process.env,
  })
  child.unref()
  if (logFd !== undefined) closeSync(logFd)
}

export interface HandlerDeps {
  socketFetch?: SocketFetch
  ensure?: typeof ensureDaemon
  spawnDaemon?: (packageDir: string) => void
  /** Extracts the embedded helper. Default: `extractHelper`. */
  extract?: (packageDir: string) => ExtractResult
}

const handler = async (ctx: TUIContext): Promise<TUIResult> => {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "Computer: wrong trigger type", is_error: true }
  }
  return runWithDeps(ctx, {})
}

/** Test-injectable inner. */
export async function runWithDeps(ctx: TUIContext, deps: HandlerDeps): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "Computer: wrong trigger type", is_error: true }
  }

  const v = validateToolInput(ctx.trigger.input, { cwd: ctx.cwd })
  if (!v.ok) {
    return {
      kind: "tool_result",
      content: `Computer: ${v.error}`,
      is_error: true,
      displayHeader: red("invalid input"),
      display: dim(v.error),
    }
  }

  const socketFetch = deps.socketFetch ?? makeBunSocketFetch(SOCK)
  const ensure = deps.ensure ?? ensureDaemon
  const doSpawn = deps.spawnDaemon ?? spawnDaemon
  const extract = deps.extract ?? extractHelper

  // A compiled CLI keeps the helper in its embedded table. Write it to disk
  // before the lookup. A dev checkout and a build with no helper write nothing.
  const got = extract(ctx.packageDir)
  if (!got.ok) {
    return {
      kind: "tool_result",
      content: `Computer: ${got.error}. Check the helper log: ${LOG}`,
      is_error: true,
      displayHeader: red("helper extract failed"),
    }
  }

  // If the helper is missing, give a precise instruction instead of a generic
  // "unreachable" (auto-spawn would silently fail). Only a dev checkout can
  // build it. A compiled CLI user has no build tools.
  const bin = helperBinary(ctx.packageDir)
  if (!deps.socketFetch && !existsSync(bin)) {
    const source = isSourceCheckout(ctx.packageDir)
    return {
      kind: "tool_result",
      content: missingHelperText(bin, source),
      is_error: true,
      displayHeader: red(source ? "helper not built" : "helper not included"),
    }
  }

  // A ping that gives an old protocol (or none) means an old helper holds the
  // socket. ensure stops it (SIGTERM to the pid of its ping) and starts this one.
  const up = await ensure({
    sock: SOCK,
    probe: async () => {
      try {
        return parsePing(await socketFetch("ping", undefined, { timeoutMs: PING_TIMEOUT_MS }))
      } catch {
        return null
      }
    },
    spawn: () => doSpawn(ctx.packageDir),
    logPath: LOG,
  })

  if (!up.ok) {
    return {
      kind: "tool_result",
      content: `Computer: ${up.error}`,
      is_error: true,
      displayHeader: red(up.header),
    }
  }

  let res: { status: number; body: unknown }
  try {
    res = await socketFetch(v.route, v.body)
  } catch (e) {
    if (e instanceof HelperTimeoutError) {
      return {
        kind: "tool_result",
        content: `Computer: ${e.message}`,
        is_error: true,
        displayHeader: red("helper timeout"),
      }
    }
    return {
      kind: "tool_result",
      content: `Computer: request failed: ${e instanceof Error ? e.message : String(e)}`,
      is_error: true,
      displayHeader: red("request failed"),
    }
  }

  const isErr = isErrorBody(res.status, res.body)
  return {
    kind: "tool_result",
    content: renderContent(res.body),
    is_error: isErr,
    displayHeader: isErr ? red(v.route) : dim(v.route),
    displayFooter: dim(summarize(v.route, res.body)),
  }
}

export default handler
