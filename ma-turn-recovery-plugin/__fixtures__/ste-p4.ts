/**
 * P4 STE rewrite: each old core text of this plugin and its new text. The old
 * texts stay in `tests/text-parity/fixtures/synthetic.json` (core reads that
 * file, so it does not change). The parity test maps each old fixture text to
 * the new text with {@link toSte} and compares the provider output with it.
 */

/**
 * [old, new] for each `prompts/*.md` file (whole text). `%%name%%` in the old
 * text matches any value on one line, and the new text gets the same value.
 */
const PROMPT_REWRITES: ReadonlyArray<readonly [string, string]> = [
  // prompts/output-truncated.md
  [
    "<ma::agent::output-truncated />\nYour previous response was cut off at the max_tokens output ceiling. Continue exactly from where you stopped. Do not repeat what you already wrote. If you were about to call a tool, issue that tool call now.",
    "<ma::agent::output-truncated />\nYour previous response stopped at the max_tokens output limit. Continue exactly from the point where you stopped. Do not write again what you already wrote. If your next step was a tool call, make that tool call now.",
  ],
  // prompts/reflection-checkpoint.tmpl.md
  [
    '<ma::agent::reflection-checkpoint round="%%round%%" cooldown-applied-seconds="%%cooldownSec%%" />\nSoft checkpoint, not a stop signal. Briefly consider whether you are still on track, then continue, change strategy, or pause and ask the user. Write `<ma::agent::reflection-ack silence-for="K" reason="..." />` as inline text anywhere in your response body (not a tool call) to suppress the next K checkpoints (skipping both the cooldown and this attachment).',
    '<ma::agent::reflection-checkpoint round="%%round%%" cooldown-applied-seconds="%%cooldownSec%%" />\nThis checkpoint is soft. It is not a signal to stop. Briefly examine if your work still moves toward the goal. Then do one of these steps:\n\n- Continue.\n- Change your strategy.\n- Pause and ask the user.\n\nTo prevent the next K checkpoints, write `<ma::agent::reflection-ack silence-for="K" reason="..." />` as inline text in your response body. You can put the tag at any position in the response body. Do not write it as a tool call. For these K checkpoints, the harness does not apply the cooldown and does not add this attachment.',
  ],
  // prompts/response-truncated-placeholder.md
  [
    "[response truncated at the output-token limit before any content was produced]",
    "[response truncated at the output-token limit, with no content]",
  ],
  // prompts/session-resumed.md
  [
    "<ma::agent::session-resumed />\nThis session was restarted and has incomplete work. Your previous conversation is preserved in the transcript above. Continue exactly from where you left off. Do not re-explain your plan, re-read files you already read, or ask what to do next. Resume the work.",
    "<ma::agent::session-resumed />\nThis session started again, and it has work that is not complete. Your previous conversation is in the transcript above. Continue exactly from the point where you stopped.\n\n- Do not explain your plan again.\n- Do not read a file again if you already read it.\n- Do not ask what to do next.\n\nContinue the work.",
  ],
  // prompts/stream-interrupted-continue.md
  [
    "<ma::agent::stream-interrupted />\nThe provider closed its previous response early (no terminal stream event) before finishing. Your partial output above is already in the transcript. Continue exactly from where you stopped. Do not repeat what you already wrote. If you were about to call a tool, issue that tool call now.",
    "<ma::agent::stream-interrupted />\nThe provider closed its previous response before the response was complete. The stream had no terminal event. Your partial output above is already in the transcript. Continue exactly from the point where you stopped. Do not write again what you already wrote. If your next step was a tool call, make that tool call now.",
  ],
  // prompts/stream-interrupted.md
  [
    "<ma::agent::stream-interrupted />\nThe provider closed its previous response early (no terminal stream event) after one or more complete tool calls. Those completed tool results are already in this turn. Do not repeat those tool calls. Continue from the current state only.",
    "<ma::agent::stream-interrupted />\nThe provider closed its previous response before the response was complete. The stream had no terminal event. The provider closed it after one or more complete tool calls. The results of those tool calls are already in this turn. Do not make those tool calls again. Continue only from the current state.",
  ],
  // prompts/turn-aborted.md
  [
    "<ma::agent::turn-aborted />\nThe previous turn was interrupted by the user before it finished. Everything already completed above is preserved (this is not an error). Treat the earlier plan as paused: address the new instruction below, and do not silently resume the prior plan unless the user asks you to continue it.",
    "<ma::agent::turn-aborted />\nThe user stopped the previous turn before it finished. This is not an error. The completed work above stays in the transcript. Pause the earlier plan. Do the new instruction below. Do not continue the earlier plan unless the user tells you to continue it.",
  ],
]

/**
 * [old, new] for the constants and template literals of provider.ts. These
 * replace a substring, so the facts around them stay as they are. The order
 * matters: a longer old text comes before a shorter one that it contains.
 */
const INLINE_REWRITES: ReadonlyArray<readonly [string, string]> = [
  [
    "The process stopped while this tool call ran. It may have run fully, partly, or not at all. Check its effects before you run it again.",
    "The process stopped while this tool call ran. The tool call possibly ran to the end, stopped before the end, or did not start. Examine its effects before you run it again.",
  ],
  [
    "Tool execution aborted by user before completion.",
    "The user stopped this tool call before it finished.",
  ],
  ["Tool blocked by lifecycle policy hook.", "A lifecycle policy hook prevented this tool call."],
  ["Plugin tool canceled.", "The plugin tool call was stopped."],
  ["no tool executor is configured for this session", "this session has no tool executor"],
  ["Turn stop blocked by turn.willStop hook.", "The turn.willStop hook did not let the turn stop."],
  [
    "reflection-ack applied. Next time, write this tag as inline text in your response body, not as a tool call.",
    "reflection-ack applied. Next time, write this tag as inline text in your response body. Do not write it as a tool call.",
  ],
  [
    "Mode tool reached the dispatcher. The agent loop should have handled it. File a bug : see the `Mode` interceptor in `src/loops/tool-round.ts`.",
    "The Mode tool call reached the dispatcher. The agent loop must handle this tool call first. Report a bug. Refer to the `Mode` interceptor in `src/loops/tool-round.ts`.",
  ],
  [" doesn't accept ", " does not accept "],
  [" isn't a supported type for ", " is not a supported type for "],
  ["attachments total exceeds the ", "the total size of the attachments is more than the "],
  [" exceeds the ", " is more than the "],
  [
    "Error: Subprocess output exceeded maximum length of ",
    "Error: The subprocess output was more than the maximum length of ",
  ],
  [" error: lock acquire failed: ", " error: cannot get the lock: "],
  ["input rewritten by policy: ", "the policy changed the input: "],
  [" unavailable]", " is not available]"],
]

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** A regex for an old template. Each `%%name%%` captures its value once. */
function templateRe(template: string): RegExp {
  const names: string[] = []
  const src = template
    .split(/(%%[A-Za-z0-9_.-]+%%)/)
    .map((part) => {
      const m = /^%%([A-Za-z0-9_.-]+)%%$/.exec(part)
      if (m === null) return escape(part)
      const name = m[1] ?? ""
      if (names.includes(name)) return `\\k<${name}>`
      names.push(name)
      return `(?<${name}>[^\\n]*?)`
    })
    .join("")
  return new RegExp(`^${src}$`)
}

/**
 * The number of texts that each rule changed, in rule order. `toSte` adds to
 * these counters. The parity test asserts that each rule hit at least once.
 */
export const RULE_HITS: { prompt: number[]; inline: number[] } = {
  prompt: PROMPT_REWRITES.map(() => 0),
  inline: INLINE_REWRITES.map(() => 0),
}

/** The old text of each rule, in the same order as {@link RULE_HITS}. */
export const RULE_NAMES: { prompt: string[]; inline: string[] } = {
  prompt: PROMPT_REWRITES.map(([o]) => o),
  inline: INLINE_REWRITES.map(([o]) => o),
}

/** The P4 STE text of one old fixture text. Returns the input if no rewrite hits. */
export function toSte(text: string): string {
  for (const [i, [oldText, newText]] of PROMPT_REWRITES.entries()) {
    const m = templateRe(oldText).exec(text)
    if (m === null) continue
    RULE_HITS.prompt[i] = (RULE_HITS.prompt[i] ?? 0) + 1
    const groups = m.groups ?? {}
    return newText.replace(/%%([A-Za-z0-9_.-]+)%%/g, (_f, n: string) => groups[n] ?? `%%${n}%%`)
  }
  let out = text
  for (const [i, [oldText, newText]] of INLINE_REWRITES.entries()) {
    const next = out.replaceAll(oldText, newText)
    if (next !== out) RULE_HITS.inline[i] = (RULE_HITS.inline[i] ?? 0) + 1
    out = next
  }
  return out
}
