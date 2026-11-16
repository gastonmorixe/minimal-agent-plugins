/**
 * P4 STE rewrite: the old core text of each data file of `prompts/` and its
 * new text. The old texts stay in `__fixtures__/old-*.txt` and in
 * `tests/text-parity/fixtures/system.json` (core reads that file, so it does
 * not change). The tests map each old text to the new text with {@link toSte}
 * and compare the provider output with the result.
 */

/** [old template, new template] for each data file. `%%name%%` matches any value. */
export const STE_REWRITES: ReadonlyArray<readonly [string, string]> = [
  // prompts/identity.neutral.md
  [
    "You are Minimal Agent, a minimalistic AI agent CLI harness for the terminal.",
    "You are Minimal Agent, a minimal AI agent that runs as a CLI harness in the terminal.",
  ],
  // prompts/instructions.md
  [
    "# Instructions (INS)\n\nINS-01 MUST write thinking, replies, and all output in Simplified Technical English (ASD-STE100), to keep the text clear.\nINS-02 MUST keep each reply short and direct.\nINS-03 MUST use Task with subtasks, and do the work in phases.\nINS-04 SHOULD give work to sub-agents, to keep the main context free.\nINS-05 MUST NOT fill the main context, because the session cannot continue when the context is full.\n\n# Minimal Agent (MA)\n\nMA-01 DEF Config and state are in `%%agentHome%%/`.\nMA-02 DEF The transcript of this session is `%%agentHome%%/sessions/<session_id>.jsonl`.\nMA-03 DEF If `MINIMAL_AGENT_NET_DBG=1` is set, network request and response logs go to `%%agentHome%%/net-dbg/`.\nMA-04 DEF Each net-dbg log folder has a date, and its name ends with `-minimal-agent-<session_id>`.",
    "# Instructions (INS)\n\nINS-01 MUST write thinking, replies, and all output in Simplified Technical English (ASD-STE100), to keep the text clear.\nINS-02 MUST keep each reply short and direct.\nINS-03 MUST use Task with subtasks, and do the work in phases.\nINS-04 SHOULD give work to sub-agents, to keep the main context free.\nINS-05 MUST NOT fill the main context, because the session cannot continue when the context is full.\n\n# Minimal Agent (MA)\n\nMA-01 DEF The config and state files are in `%%agentHome%%/`.\nMA-02 DEF The transcript of this session is `%%agentHome%%/sessions/<session_id>.jsonl`.\nMA-03 DEF If the environment has `MINIMAL_AGENT_NET_DBG=1`, the harness writes logs of network requests and responses to `%%agentHome%%/net-dbg/`.\nMA-04 DEF The name of each net-dbg log folder has a date and ends with `-minimal-agent-<session_id>`.",
  ],
  // prompts/loop-safety/heading.md
  ["# Tool-use loop safety", "# Tool loop safety"],
  // prompts/loop-safety/intro.md
  [
    "The agentic tool-use loop has no fixed turn cap by default. Long autonomous tasks (multi-file refactors, audits, sustained research) can run for many rounds without interruption.",
    "By default, the tool loop has no fixed limit on the number of rounds. A long autonomous task can run for many rounds without a stop. Examples: a refactor of many files, an audit, or long research.",
  ],
  // prompts/loop-safety/checkpoint-cooldown.tmpl.md
  [
    'A reflection checkpoint fires every %%interval%% tool rounds. The harness applies a %%cooldownSec%%-second wall-clock cooldown (a human watching can press Esc to interrupt during the countdown). Then it injects a `<ma::agent::reflection-checkpoint round="N" cooldown-applied-seconds="%%cooldownSec%%" />` attachment in the next user content. It is a soft checkpoint, not a stop signal. Briefly consider whether you are still on track, then continue, change strategy, or pause and ask the user. To suppress checkpoints, write `<ma::agent::reflection-ack silence-for="K" reason="..." />` as inline text in your response body (not a tool call).',
    'A reflection checkpoint occurs every %%interval%% tool rounds. First, the harness waits %%cooldownSec%% seconds of wall-clock time. During this wait, a user who watches can push Esc to stop the wait. Then the harness adds a `<ma::agent::reflection-checkpoint round="N" cooldown-applied-seconds="%%cooldownSec%%" />` attachment to the next user content. The checkpoint is soft. It is not a stop signal.\n\nBriefly examine if your work still moves toward the goal. Then do one of these steps:\n\n- Continue.\n- Change your strategy.\n- Pause and ask the user.\n\nTo prevent checkpoints, write `<ma::agent::reflection-ack silence-for="K" reason="..." />` as inline text in your response body. Do not write it as a tool call.',
  ],
  // prompts/loop-safety/checkpoint-plain.tmpl.md
  [
    'A reflection checkpoint fires every %%interval%% tool rounds. The harness injects a `<ma::agent::reflection-checkpoint round="N" cooldown-applied-seconds="0" />` attachment in the next user content. It is a soft checkpoint, not a stop signal. Briefly consider whether you are still on track, then continue, change strategy, or pause and ask the user. To suppress checkpoints, write `<ma::agent::reflection-ack silence-for="K" reason="..." />` as inline text in your response body (not a tool call).',
    'A reflection checkpoint occurs every %%interval%% tool rounds. The harness adds a `<ma::agent::reflection-checkpoint round="N" cooldown-applied-seconds="0" />` attachment to the next user content. The checkpoint is soft. It is not a stop signal.\n\nBriefly examine if your work still moves toward the goal. Then do one of these steps:\n\n- Continue.\n- Change your strategy.\n- Pause and ask the user.\n\nTo prevent checkpoints, write `<ma::agent::reflection-ack silence-for="K" reason="..." />` as inline text in your response body. Do not write it as a tool call.',
  ],
  // prompts/loop-safety/ack.md
  [
    'To suppress the next K checkpoints during sustained autonomous work (skipping both the cooldown and the attachment), write `<ma::agent::reflection-ack silence-for="K" reason="..." />` as inline text anywhere in your response body (plain text, not a tool call). The `reason` appears in the user-visible transcript so the human running you can see why you opted out.',
    'During long autonomous work, you can prevent the next K checkpoints. To do this, write `<ma::agent::reflection-ack silence-for="K" reason="..." />` as inline text in your response body. You can put the tag at any position in the response body. Write the tag as plain text. Do not write it as a tool call. For these K checkpoints, the harness does not apply the cooldown and does not add the attachment.\n\nThe user can see the `reason` in the transcript. The `reason` tells the user why you prevented the checkpoints.',
  ],
  // prompts/tool-output-conventions.md
  [
    '# Tool output conventions\n\nEvery tool result whose body is large or got clamped by the universal 64KB / 1000-line cap also lands intact at `~/.minimal-agent/sessions/<sid>.blobs/<tool_use_id>.raw`. The agent appends a single line `<ma::agent::raw-output path="<abs-path>" size="<size>" sha256="<hex>" />` to `tool_result.content` whenever that file was written. Use `Read({file_path: "..."})` or `Bash({command: "wc -l \'...\'"})` on that path when the inline body is not enough: the file is the full pre-clamp, pre-annotation output. The clamp keeps the FRONT of the body, so when a command fails its trailing diagnostics are what got cut: Read the blob\'s tail to recover them. The blob also survives session resume, so a later turn can analyze the original bytes without re-running the tool. Small bodies under `minBytesToPersist` (default 4096 B) are not persisted and emit no footer. Their `content` is already complete.\n\nWhen the user\'s transcript previewed fewer lines than you received, the agent appends a `<ma::agent::output-preview shown="N" total="M" tool="X">` annotation. If a raw-output blob was also written for that result, the annotation carries a `path="<abs-path>"` attribute that points at the full output. The hint names that path too. So an elided preview always tells you where the rest lives.',
    '# Tool output conventions\n\nThe harness also writes the full body of a tool result to `~/.minimal-agent/sessions/<sid>.blobs/<tool_use_id>.raw` if one of these conditions is true:\n\n- The body is large.\n- The universal 64KB / 1000-line cap clamped the body.\n\nWhen the harness writes this file, it adds one line to the end of `tool_result.content`: `<ma::agent::raw-output path="<abs-path>" size="<size>" sha256="<hex>" />`. If the inline body is not sufficient, use `Read({file_path: "..."})` or `Bash({command: "wc -l \'...\'"})` on that path. The file has the full output from before the clamp and before the annotations. The clamp keeps the start of the body and removes the end. If a command fails, its diagnostics are at the end, so the clamp removed them. To get the diagnostics, use `Read` on the end of the blob.\n\nThe blob stays available after a session resume. Thus, in a later turn, you can analyze the original bytes. You do not have to run the tool again. If a body is smaller than `minBytesToPersist` (default 4096 B), the harness does not write a blob for it. The harness also does not add the footer line. The `content` of that tool result is already complete.\n\nSometimes the transcript of the user shows fewer lines than you received. In that case, the harness adds a `<ma::agent::output-preview shown="N" total="M" tool="X">` annotation. If the harness also wrote a raw-output blob for that tool result, the annotation has a `path="<abs-path>"` attribute. This attribute points to the full output. The hint text also gives that path. Thus, a shortened preview always tells you where to find the remaining output.',
  ],
]

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** A regex for an old template. Each `%%name%%` captures its value once. */
function templateRe(template: string): { re: RegExp; names: string[] } {
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
  return { re: new RegExp(src, "g"), names }
}

/**
 * Replace each old template in `text` with its new template, filled with the
 * captured values. Returns the new text and the number of templates that hit.
 */
export function toSte(
  text: string,
  rewrites: ReadonlyArray<readonly [string, string]> = STE_REWRITES,
): { text: string; hits: number } {
  let out = text
  let hits = 0
  for (const [oldText, newText] of rewrites) {
    const { re } = templateRe(oldText)
    let hit = false
    out = out.replace(re, (...args) => {
      hit = true
      const groups = (args.at(-1) ?? {}) as Record<string, string>
      return newText.replace(/%%([A-Za-z0-9_.-]+)%%/g, (_f, n: string) => groups[n] ?? `%%${n}%%`)
    })
    if (hit) hits++
  }
  return { text: out, hits }
}
