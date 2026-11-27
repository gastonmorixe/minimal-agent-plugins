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
import { closeSync, openSync, unlinkSync } from "node:fs"

import { ensureDaemon, makeBunSocketFetch, type SocketFetch } from "../lib/client.ts"
import { daemonEnv, serverArgv } from "../lib/daemon-spawn.ts"
import { validateToolInput } from "../lib/input.ts"
import { leaseDirFor, writeLease } from "../lib/lifetime.ts"
import { extractMedia } from "../lib/media-extract.ts"
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
  // Source: [bun, <pkg>/bin/cdp-server.ts]. Compiled: [<binary>, __run, ...].
  const [cmd, ...args] = serverArgv(packageDir)
  let logFd: number | undefined
  try {
    logFd = openSync(LOG, "a")
  } catch {
    logFd = undefined
  }
  const child = spawn(cmd, args, {
    detached: true,
    stdio: logFd === undefined ? "ignore" : ["ignore", logFd, logFd],
    env: daemonEnv(),
  })
  child.unref()
  if (logFd !== undefined) closeSync(logFd)
}

// The lease file this process wrote, and whether the exit cleanup is armed.
let leasePath: string | undefined
let exitHookArmed = false

/** Remove this process's lease. Sync, because it runs in the `exit` event. */
function removeLease(): void {
  if (leasePath === undefined) return
  try {
    unlinkSync(leasePath)
  } catch {
    // already swept or never written
  }
}

/**
 * Write or refresh this process's lease on each call, so the daemon sweep
 * sees a recent time (see lib/lifetime). The first write arms one `exit`
 * listener that removes the lease. A failure is ignored: the idle rule still
 * applies.
 */
function refreshLease(): void {
  try {
    leasePath = writeLease(leaseDirFor(SOCK, process.env.CDP_LEASE_DIR))
  } catch {
    // no lease: the daemon then ends after CDP_IDLE_MS of no requests
    return
  }
  if (exitHookArmed) return
  exitHookArmed = true
  process.on("exit", removeLease)
}

export interface HandlerDeps {
  socketFetch?: SocketFetch
  ensure?: typeof ensureDaemon
  spawnDaemon?: (packageDir: string) => void
  /** Lease writer (tests). Default: write or refresh `<lease dir>/<pid>` on each call. */
  writeLease?: () => void
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

  // The lease tells the daemon this process still uses it (see lib/lifetime).
  // Written before the ensure, so a fresh daemon sees it at once.
  ;(deps.writeLease ?? refreshLease)()

  const up = await ensure({
    sock: SOCK,
    lockPath: `${SOCK}.spawn.lock`,
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
  // Base64 media (a screenshot, a PDF, screencast frames) goes to core as
  // attachments. The model and the TUI get a short placeholder, not base64.
  const media = extractMedia(res.body, {
    action: v.route,
    method: typeof v.body.method === "string" ? v.body.method : undefined,
    params: v.body.params,
  })
  return {
    kind: "tool_result",
    content: renderContent(media.body),
    is_error: isErr,
    displayHeader: reqHeader,
    display: renderDisplay(v.route, v.body, media.body),
    displayFooter: dim(summarize(v.route, media.body)),
    ...(media.attachments.length > 0 ? { attachments: media.attachments } : {}),
  }
}

export default handler
