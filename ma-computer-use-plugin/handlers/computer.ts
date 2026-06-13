/**
 * Tool-call handler for `Computer`.
 *
 * Talks to the signed ComputerUseHelper daemon over its unix domain socket. If
 * the daemon isn't running it auto-spawns the signed .app (exec'd directly so
 * TCC attributes permission grants to ComputerUseHelper.app, never bun), then
 * forwards the validated action and shapes the response into a TUIResult.
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

import { ensureDaemon, makeBunSocketFetch, type SocketFetch } from "../lib/client.ts"
import { helperBinary, logPath, socketPath, supportDir } from "../lib/paths.ts"
import { configureSgr, dim, isErrorBody, red, renderContent, summarize } from "../lib/render.ts"
import { validateToolInput } from "../lib/routes.ts"
import type { TUIContext, TUIResult } from "../lib/types.ts"

const SOCK = socketPath()
const LOG = logPath()

/**
 * Spawn the signed .app binary detached so it outlives this tool call. Its
 * stdout+stderr append to LOG. Exec'ing the in-bundle binary preserves the
 * bundle's signed identity for TCC.
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
}

const handler = async (ctx: TUIContext): Promise<TUIResult> => {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "Computer: wrong trigger type", is_error: true }
  }
  return runWithDeps(ctx, {})
}

/** Test-injectable inner. */
export async function runWithDeps(ctx: TUIContext, deps: HandlerDeps): Promise<TUIResult> {
  configureSgr(ctx.env.MINIMAL_AGENT_PALETTE)

  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "Computer: wrong trigger type", is_error: true }
  }

  const v = validateToolInput(ctx.trigger.input)
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

  // If the helper isn't built, give a precise instruction instead of a generic
  // "unreachable" (auto-spawn would silently fail).
  if (!deps.socketFetch && !existsSync(helperBinary(ctx.packageDir))) {
    return {
      kind: "tool_result",
      content:
        "Computer: the ComputerUseHelper.app is not built yet. Build it once with:\n" +
        "  cd ma-computer-use-plugin && bun run bin/cud.ts build\n" +
        "Then grant permissions: bun run bin/cud.ts prompt (enable ComputerUseHelper in System Settings → Accessibility + Screen Recording).",
      is_error: true,
      displayHeader: red("helper not built"),
    }
  }

  const up = await ensure({
    sock: SOCK,
    ping: async () => {
      try {
        const r = await socketFetch("ping")
        return r.status === 200
      } catch {
        return false
      }
    },
    spawn: () => doSpawn(ctx.packageDir),
  })

  if (!up) {
    return {
      kind: "tool_result",
      content:
        "Computer: the ComputerUseHelper daemon is not reachable and could not be started. " +
        "Check logs with: bun run bin/cud.ts logs",
      is_error: true,
      displayHeader: red("daemon unreachable"),
    }
  }

  let res: { status: number; body: unknown }
  try {
    res = await socketFetch(v.route, v.body)
  } catch (e) {
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
