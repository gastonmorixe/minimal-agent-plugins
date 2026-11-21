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
    "# Instructions (INS)\n\nINS-01 MUST write thinking, replies, and all output in Simplified Technical English (ASD-STE100), to keep the text clear.\nINS-02 MUST keep each reply short and direct.\nINS-03 MUST use Task with subtasks, and do the work in phases.\nINS-04 SHOULD give work to sub-agents, to keep the main context free.\nINS-05 MUST NOT fill the main context, because the session cannot continue when the context is full.\n\n# Minimal Agent (MA)\n\nMA-01 DEF The config and state files are in `%%agentHome%%/`.\nMA-02 DEF If the host saves the transcript of this session, the file is `%%agentHome%%/sessions/<session_id>.jsonl`. Some hosts keep it only in memory. `SessionInfo` gives the session id.\nMA-03 DEF If the environment has `MINIMAL_AGENT_NET_DBG=1`, the harness writes logs of network requests and responses to `%%agentHome%%/net-dbg/`.\nMA-04 DEF The name of each net-dbg log folder has a date and ends with `-minimal-agent-<session_id>`.",
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
