/**
 * `SessionTitle` tool: set the title of the live session.
 *
 * Input:
 * 1. `title` (optional): the new title. With it, the tool writes this title
 *    and makes no model call.
 * 2. `lock` (optional, default false): true writes a `user` title, which an
 *    automatic title does not replace. False writes an `ai` title.
 *
 * Without `title`, the tool makes a new title with the same model choice,
 * request and check as the automatic path (`lib/generate.ts`). The input is
 * the first user message and the last 3 user messages of the session, with
 * the same clean steps as the automatic path. This is a new title, so the
 * tool does not stop when a title exists. This path makes a model call, so
 * it obeys the off switches of the plugin (`plugins.title.enabled: false`,
 * `MINIMAL_AGENT_TITLE=0`). A given title always works.
 *
 * The generate path has a cooldown of {@link REGENERATE_COOLDOWN_MS} for each
 * sid (`lastRegenerateAt` in `lib/shared.ts`, in this process only). The time
 * starts when the model call starts, so a failed call also counts. A call
 * inside the cooldown makes no model call and gives an error with the title.
 * There is no limit on the number of calls in a session.
 *
 * The first part is the clean first prompt that the automatic handler kept
 * (`firstText` in `lib/shared.ts`), when it exists. The session records hold
 * the expanded saved prompts (`ma-prompts-plugin` rewrites `&name` to the
 * body), so the tool removes each body of the prompt library from the record
 * text (`lib/prompt-library.ts`).
 *
 * `lock: true` needs a `title`: a locked title comes from the user.
 *
 * Core drops an `ai` write with no error when a `user` title exists. Thus,
 * with `lock: false`, the tool reads the title state first and writes
 * nothing when a `user` title exists.
 *
 * The tool marks the sid as done for the automatic handler (`lib/shared.ts`)
 * before it writes, so an automatic result that comes during the write is
 * dropped. A failed write puts the old state back. After a write, the tool
 * sends `title.saved` (the footer shows the title at once).
 *
 * @module handlers/session_title_tool
 */

import {
  loadTitleConfig,
  readTitleEnv,
  resolveTitleSwitch,
  type TitleConfig,
} from "../lib/config.ts"
import { markSuccess } from "../lib/eligibility.ts"
import {
  buildTitleRequest,
  checkTitleResult,
  chooseTitleModel,
  TITLE_SAVED_EVENT,
  type TitleSavedEvent,
  titleLanguage,
} from "../lib/generate.ts"
import type {
  SessionMessageSlice,
  SessionTitleInput,
  SessionTitleState,
  TitleHost,
  TitleSideband,
  TitleToolContext,
  TitleToolResult,
} from "../lib/host-types.ts"
import { type CleanOptions, cleanPromptText, wrapCleanText } from "../lib/input.ts"
import { loadPromptBodies, removePromptBodies } from "../lib/prompt-library.ts"
import { defaultTitleShared, type TitleShared } from "../lib/shared.ts"

/** Log source. */
const LOG_SOURCE = "title"

/** The number of last user messages that the generate path reads. */
export const LAST_USER_MESSAGES = 3

/**
 * The minimum time between two generate calls (no `title`) for one sid:
 * 10 minutes. A given `title` has no limit.
 */
export const REGENERATE_COOLDOWN_MS = 10 * 60 * 1000

/** The parsed tool input. */
interface ToolInput {
  title?: string
  lock: boolean
}

/** One error result. */
function fail(content: string): TitleToolResult {
  return { kind: "tool_result", content, is_error: true }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Parse the tool input. A string result is the error text. */
function parseInput(ctx: TitleToolContext): ToolInput | string {
  const raw = ctx.trigger.type === "tool" && "input" in ctx.trigger ? ctx.trigger.input : {}
  const input = raw && typeof raw === "object" ? raw : {}
  const { title, lock } = input as { title?: unknown; lock?: unknown }
  if (lock !== undefined && typeof lock !== "boolean") return "lock must be a boolean."
  if (title !== undefined && typeof title !== "string") return "title must be a string."
  const out: ToolInput = { lock: lock === true }
  if (typeof title === "string") {
    if (title.trim() === "") return "title is empty. Give a title, or do not give the title field."
    out.title = title.trim()
  }
  if (out.lock && out.title === undefined) {
    return "lock: true needs a title. Give the title that the user gave you."
  }
  return out
}

/** The text of one message: a string, or its text blocks that are not internal blocks. */
export function messageText(msg: SessionMessageSlice): string {
  if (typeof msg.content === "string") return msg.content
  const parts: string[] = []
  for (const block of msg.content) {
    if (block.type !== "text" || block.sideband) continue
    if (typeof block.text === "string") parts.push(block.text)
  }
  return parts.join("\n")
}

/** Options of {@link conversationText}. */
export interface ConversationOptions extends CleanOptions {
  /** The bodies of the saved prompts. Each one is removed before the clean step. */
  bodies?: readonly string[]
  /** A clean first text. When set, it replaces the text of the first message. */
  firstText?: string
}

/**
 * The clean text of the user messages for a new title: the first user
 * message and the last {@link LAST_USER_MESSAGES} user messages, with no
 * copy. A message that is empty after the clean steps does not count. The
 * texts are joined with a blank line. Only these messages are cleaned, so
 * only their paste files are read.
 */
export function conversationText(
  messages: readonly SessionMessageSlice[],
  sb: TitleSideband,
  opts: ConversationOptions = {},
): string {
  const users = messages.filter((m) => m.role === "user")
  const clean = (msg: SessionMessageSlice): string =>
    cleanPromptText(removePromptBodies(messageText(msg), opts.bodies ?? []), sb, opts)
  let first = ""
  let firstIdx = users.length
  for (let i = 0; i < users.length; i++) {
    const msg = users[i]
    first = msg ? clean(msg) : ""
    if (first !== "") {
      firstIdx = i
      break
    }
  }
  const given = opts.firstText?.trim() ?? ""
  if (given !== "") first = given
  const tail: string[] = []
  for (let i = users.length - 1; i > firstIdx && tail.length < LAST_USER_MESSAGES; i--) {
    const msg = users[i]
    const text = msg ? clean(msg) : ""
    if (text !== "") tail.unshift(text)
  }
  return [first, ...tail].filter((t) => t !== "").join("\n\n")
}

/** Options of {@link createSessionTitleTool} (tests). */
export interface SessionTitleToolOptions {
  /** The bodies of the saved prompts. Default: {@link loadPromptBodies}. */
  promptBodies?: (env: Record<string, string>, cwd: string | undefined) => readonly string[]
  /** The clock in ms for the cooldown. Default: `Date.now`. */
  now?: () => number
}

/** The title that the session shows: `user`, then `ai`, then `derived`. Empty when none. */
function currentTitle(state: SessionTitleState): string {
  for (const rec of [state.user, state.ai, state.derived]) {
    const title = rec?.title?.trim() ?? ""
    if (title !== "") return title
  }
  return ""
}

/** The error text of a generate call inside the cooldown. */
function cooldownText(elapsedMs: number, title: string): string {
  const min = Math.floor(elapsedMs / 60_000)
  const ago = min < 1 ? "less than 1 minute ago" : min === 1 ? "1 minute ago" : `${min} minutes ago`
  const shown = title === "" ? "The session has no title." : `The title is "${title}".`
  return `The tool made a new title ${ago}, so it makes no new title now. ${shown} Give a title in the title field to set a title now.`
}

/** True when the plugin is off: `plugins.title.enabled: false` or the kill switch. */
function titleOff(config: TitleConfig, env: NodeJS.ProcessEnv): boolean {
  return !config.enabled || resolveTitleSwitch(undefined, readTitleEnv(env)) === false
}

/** The shown title of a state: `user`, then `ai`. */
function shownTitle(state: SessionTitleState): { title: string; source: "ai" | "user" } | null {
  const user = state.user?.title?.trim() ?? ""
  if (user !== "") return { title: user, source: "user" }
  const ai = state.ai?.title?.trim() ?? ""
  if (ai !== "") return { title: ai, source: "ai" }
  return null
}

/** A new title from the model. A string result is the error text. */
async function generateTitle(
  ctx: TitleToolContext,
  sid: string,
  host: TitleHost,
  config: TitleConfig,
  parts: { firstText?: string; bodies: readonly string[]; onCallStart: () => void },
): Promise<Omit<SessionTitleInput, "sid" | "source"> | string> {
  const request = host.llm?.request
  if (!request)
    return "The host has no model call API (llm.request). Give a title in the title field."
  const sb = ctx.sideband
  if (!sb?.ready) return "The host has no sideband codec. Give a title in the title field."
  const records = host.sessions?.records
  if (!records) return "The host cannot read the session. Give a title in the title field."
  let view: Awaited<ReturnType<typeof records>>
  try {
    view = await records.call(host.sessions, sid)
  } catch (err) {
    return `Cannot read the session: ${errText(err)}`
  }
  const text = conversationText(view?.messages ?? [], sb, {
    sid,
    bodies: parts.bodies,
    ...(parts.firstText ? { firstText: parts.firstText } : {}),
  })
  if (text === "") return "The session has no user text. Give a title in the title field."

  const env: NodeJS.ProcessEnv = { ...ctx.env }
  const { choice } = chooseTitleModel({
    models: host.models,
    run: ctx.run,
    agentModel: ctx.agent?.model,
    config,
    env,
  })
  if (!choice.ok) return `No title model: ${choice.reason}. Give a title in the title field.`

  const userText = wrapCleanText(text, titleLanguage(config, env))
  const req = buildTitleRequest(choice, userText, config, ctx.abort)
  let res: Awaited<ReturnType<typeof request>>
  // The cooldown starts here: a failed call also counts.
  parts.onCallStart()
  try {
    res = await request.call(host.llm, req)
  } catch (err) {
    return `The title request failed: ${errText(err)}`
  }
  const valid = checkTitleResult(res, sb)
  if (!valid.ok) {
    const why = res.reason ? `, reason ${res.reason}` : ""
    return `The model gave no usable title (${valid.reason}, stop reason ${res.stopReason}${why}).`
  }
  return {
    title: valid.title,
    model: res.model || req.model,
    provider: res.provider || choice.providerId,
    usage: {
      inputTokens: res.usage?.inputTokens ?? 0,
      outputTokens: res.usage?.outputTokens ?? 0,
      ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
    },
  }
}

/** Make a tool handler with a given shared state (tests). */
export function createSessionTitleTool(
  shared: TitleShared = defaultTitleShared,
  opts: SessionTitleToolOptions = {},
): (ctx: TitleToolContext) => Promise<TitleToolResult> {
  const promptBodies = opts.promptBodies ?? loadPromptBodies
  const now = opts.now ?? Date.now
  return async (ctx) => {
    const debug = (msg: string): void => {
      try {
        ctx.log.debug(LOG_SOURCE, msg)
      } catch {
        /* a broken logger must not throw */
      }
    }
    const input = parseInput(ctx)
    if (typeof input === "string") return fail(input)

    const sid = ctx.agent?.sessionId?.trim() ?? ""
    if (sid === "") return fail("No live session: the tool has no session id.")
    const host = ctx.host
    const meta = host?.sessionMeta
    if (!host || !meta) return fail("The host gives no title API (sessions:meta).")

    const source = input.lock ? "user" : "ai"
    if (!input.lock) {
      let state: SessionTitleState
      try {
        state = meta.getTitle(sid)
      } catch (err) {
        return fail(`Cannot read the title: ${errText(err)}`)
      }
      const user = state.user?.title?.trim() ?? ""
      if (user !== "") {
        return fail(
          `A user title exists: "${user}". An automatic title does not replace it. Use lock: true only when the user tells you to change the title.`,
        )
      }
    }

    let write: Omit<SessionTitleInput, "sid" | "source">
    if (input.title !== undefined) {
      write = { title: input.title }
    } else {
      const env: NodeJS.ProcessEnv = { ...ctx.env }
      const config = loadTitleConfig(env, debug)
      if (titleOff(config, env)) {
        return fail(
          "The title plugin is off (plugins.title.enabled: false, MINIMAL_AGENT_TITLE=0 or --no-title), so the tool makes no title. Give a title in the title field.",
        )
      }
      const last = shared.lastRegenerateAt.get(sid)
      if (last !== undefined) {
        const elapsed = now() - last
        if (elapsed >= 0 && elapsed < REGENERATE_COOLDOWN_MS) {
          let title = ""
          try {
            title = currentTitle(meta.getTitle(sid))
          } catch {
            /* the error text then says that the session has no title */
          }
          debug(`title sid=${sid} regenerate cooldown, ${elapsed} ms after the last call`)
          return fail(cooldownText(elapsed, title))
        }
      }
      let bodies: readonly string[]
      try {
        bodies = promptBodies(ctx.env, ctx.cwd)
      } catch {
        bodies = []
      }
      const firstText = shared.states.get(sid)?.firstText
      const made = await generateTitle(ctx, sid, host, config, {
        bodies,
        ...(firstText ? { firstText } : {}),
        onCallStart: () => shared.lastRegenerateAt.set(sid, now()),
      })
      if (typeof made === "string") return fail(made)
      write = made
    }

    // Mark the sid done before the write: an automatic result that comes
    // during the write is then dropped (`runCall` reads the state).
    const before = shared.states.get(sid)
    const marked = markSuccess(before)
    shared.states.set(sid, marked)
    // After a failed write: put the old state back. When the automatic
    // handler changed the state meanwhile (it dropped its result), keep its
    // change but clear `done`: no title was written.
    const restore = (): void => {
      const now = shared.states.get(sid)
      if (now && now !== marked) shared.states.set(sid, { ...now, done: false })
      else if (before) shared.states.set(sid, before)
      else shared.states.delete(sid)
    }
    try {
      await meta.setTitle({ sid, source, ...write })
    } catch (err) {
      restore()
      const code = (err as { code?: unknown })?.code
      return fail(
        `The title write failed${typeof code === "string" ? ` (${code})` : ""}: ${errText(err)}`,
      )
    }

    // Core cleans the title (tags, white space, 80 code points). Read it back.
    let saved: { title: string; source: "ai" | "user" } | null
    try {
      saved = shownTitle(meta.getTitle(sid))
    } catch {
      saved = { title: write.title, source }
    }
    if (!saved || saved.source !== source) {
      restore()
      return fail("The host did not keep the title.")
    }

    const ev: TitleSavedEvent = { sid, title: saved.title, source }
    try {
      shared.emit?.(TITLE_SAVED_EVENT, ev)
    } catch {
      /* a refresh signal is best effort */
    }
    debug(`title sid=${sid} source=${source} by tool`)
    return {
      kind: "tool_result",
      content: `Title: ${saved.title} (source: ${source})`,
      displayHeader: saved.title,
    }
  }
}

/** The handler that the manifest names (`export: "default"`). */
const sessionTitleTool = createSessionTitleTool()

export default sessionTitleTool
