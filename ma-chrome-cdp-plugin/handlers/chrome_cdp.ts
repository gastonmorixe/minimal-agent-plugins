/**
 * Tool-call handler for `ChromeCDP`.
 *
 * Talks to the persistent CDP daemon over its unix domain socket. If the
 * daemon isn't running it spawns it once (the single macOS Local Network allow
 * prompt), then forwards the validated action and shapes the response into a
 * `TUIResult`.
 *
 * The pure pieces (input validation, response rendering, daemon lifecycle) are
 * in `lib/` and unit-tested. This file is the thin imperative shell.
 *
 * @module handlers/chrome_cdp
 */

import { spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { join } from "node:path"

import { ensureDaemon, makeBunSocketFetch, type SocketFetch } from "../lib/client.ts"
import { validateToolInput } from "../lib/input.ts"
import {
  describeRequest,
  dim,
  isErrorBody,
  red,
  renderContent,
  renderDisplay,
  summarize,
} from "../lib/render.ts"
import type { TUIContext, TUIResult } from "../lib/types.ts"

const SOCK = process.env.CDP_SOCK ?? "/tmp/cdp.sock"
const LOG = process.env.CDP_LOG ?? "/tmp/cdp-server.log"

/**
 * Spawn the daemon detached so it outlives this tool call. Its stdout+stderr
 * append to CDP_LOG (the same file `cdpd logs` tails), so a failed auto-spawn
 * leaves a diagnosable trail instead of vanishing. Falls back to ignoring the
 * streams if the log file can't be opened.
 */
function spawnDaemon(packageDir: string): void {
  const server = join(packageDir, "bin", "cdp-server.ts")
  let logFd: number | undefined
  try {
    logFd = openSync(LOG, "a")
  } catch {
    logFd = undefined
  }
  const child = spawn("bun", ["run", server], {
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
    return { kind: "tool_result", content: "ChromeCDP: wrong trigger type", is_error: true }
  }
  return runWithDeps(ctx, {})
}

/** Test-injectable inner. */
export async function runWithDeps(ctx: TUIContext, deps: HandlerDeps): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "ChromeCDP: wrong trigger type", is_error: true }
  }

  const v = validateToolInput(ctx.trigger.input)
  if (!v.ok) {
    return {
      kind: "tool_result",
      content: `ChromeCDP: ${v.error}`,
      is_error: true,
      displayHeader: red("invalid input"),
      display: dim(v.error),
    }
  }

  const socketFetch = deps.socketFetch ?? makeBunSocketFetch(SOCK)
  const ensure = deps.ensure ?? ensureDaemon
  const doSpawn = deps.spawnDaemon ?? spawnDaemon

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

  // Single source of truth for "what is being issued", reused on every exit
  // path so even a failed request shows the user the attempted command.
  const reqHeader = describeRequest(v.route, v.body)

  if (!up) {
    return {
      kind: "tool_result",
      content:
        "ChromeCDP: the CDP daemon is not reachable and could not be started. " +
        "Make sure Chrome/Chromium is running with --remote-debugging-port=9222.",
      is_error: true,
      displayHeader: reqHeader,
      display: red("✘ daemon unreachable — is Chrome running with --remote-debugging-port=9222?"),
    }
  }

  let res: { status: number; body: unknown }
  try {
    res = await socketFetch(v.route, v.body)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      kind: "tool_result",
      content: `ChromeCDP: request failed: ${msg}`,
      is_error: true,
      displayHeader: reqHeader,
      display: red(`✘ request failed — ${msg}`),
    }
  }

  const isErr = isErrorBody(res.status, res.body)
  return {
    kind: "tool_result",
    content: renderContent(res.body),
    is_error: isErr,
    displayHeader: reqHeader,
    display: renderDisplay(v.route, v.body, res.body),
    displayFooter: dim(summarize(v.route, res.body)),
  }
}

export default handler
