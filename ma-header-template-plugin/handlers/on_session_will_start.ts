/**
 * `session.willStart` handler: print the header template to stderr.
 *
 * Reads the template from `MINIMAL_AGENT_HEADER_FORMAT` in `process.env`
 * (the host resolves `--header-format`, the env var, and config
 * `headerFormat` into it). `ctx.env` strips `MINIMAL_AGENT_*`, so this reads
 * `process.env` like the hooks plugin does. Prints once per process, on the
 * first session start. Returns nothing, so no context reaches the model.
 *
 * @module header-template/handlers/on_session_will_start
 */

import { HEADER_FORMAT_ENV, renderHeader } from "../lib/render.ts"
import type { SessionFacts } from "../lib/vars.ts"

let printed = false

/** Color only on a TTY, and never with NO_COLOR set. */
function useColor(): boolean {
  const noColor = process.env.NO_COLOR
  return process.stderr.isTTY === true && (noColor === undefined || noColor === "")
}

const handler = (payload: unknown): void => {
  if (printed) return
  const p = (payload ?? {}) as Partial<SessionFacts>
  const out = renderHeader(process.env[HEADER_FORMAT_ENV], {
    facts: {
      sid: p.sid ?? process.env.MINIMAL_AGENT_SESSION_ID ?? "",
      cwd: p.cwd ?? process.cwd(),
      model: p.model ?? "",
      source: p.source ?? "",
    },
    env: process.env,
    color: useColor(),
  })
  if (out.kind === "off") return
  printed = true
  process.stderr.write(`${out.kind === "ok" ? out.text : out.message}\n`)
}

export default handler
