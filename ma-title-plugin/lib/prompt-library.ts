/**
 * Read-only access to the saved prompt library, to remove the bodies of the
 * saved prompts from session text.
 *
 * The prompts plugin (`ma-prompts-plugin`) rewrites a `&name` token to the
 * body of the saved prompt before the turn. Thus the session records hold the
 * full body, not the token. A body is a template of general instructions,
 * not the subject of the session, so the `SessionTitle` tool removes it.
 *
 * The file layout is the same as `ma-prompts-plugin/lib/store.ts`: one
 * `<slug>.md` file for each prompt, in `<agentHome>/prompts/` (user scope)
 * and `<cwd>/.agents/prompts/` (project scope). Each file has a frontmatter
 * block between two `---` lines, then the body. A plugin does not import
 * another plugin, so this module has a minimal copy of the parse step. It
 * reads only and never writes.
 *
 * @module lib/prompt-library
 */

import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Max prompt files that the loader reads, over all dirs. */
export const PROMPT_FILES_MAX = 500

/** Max bytes that the loader reads from one prompt file. A larger file is skipped. */
export const PROMPT_FILE_MAX_BYTES = 64 * 1024

/**
 * The agent home: a non-blank `MINIMAL_AGENT_HOME`, else `$HOME/.minimal-agent`,
 * else `os.homedir()/.minimal-agent`. The same rule as
 * `ma-prompts-plugin/lib/agent-home.ts`.
 */
export function promptAgentHome(env: Record<string, string | undefined>): string {
  const raw = env.MINIMAL_AGENT_HOME?.trim() ?? ""
  if (raw !== "") return raw
  const home = env.HOME?.trim() || homedir()
  return join(home, ".minimal-agent")
}

/** The prompt dirs: the project scope (when a cwd is known), then the user scope. */
export function promptDirs(env: Record<string, string | undefined>, cwd?: string): string[] {
  const dirs: string[] = []
  if (cwd) dirs.push(join(cwd, ".agents", "prompts"))
  dirs.push(join(promptAgentHome(env), "prompts"))
  return dirs
}

/**
 * The body of a prompt file: the text after the closing `---` line of the
 * frontmatter. CRLF becomes LF. Gives null when the file has no frontmatter.
 */
export function promptFileBody(raw: string): string | null {
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n?/g, "\n")
  const lines = text.split("\n")
  if (lines[0]?.trimEnd() !== "---") return null
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trimEnd() === "---") return lines.slice(i + 1).join("\n")
  }
  return null
}

/**
 * Read a regular file of a maximum of {@link PROMPT_FILE_MAX_BYTES} bytes.
 * Gives null for a larger file, a symlink, a file that is not regular, or an
 * error.
 */
function readSmallFile(path: string): string | null {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > PROMPT_FILE_MAX_BYTES) return null
    const buf = Buffer.alloc(st.size)
    const n = readSync(fd, buf, 0, st.size, 0)
    return buf.subarray(0, n).toString("utf8")
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* the read result stays good */
      }
    }
  }
}

/**
 * The bodies of the saved prompts (trimmed, LF, not empty). It reads a
 * maximum of {@link PROMPT_FILES_MAX} files. A dir that is missing gives no
 * body. It never throws.
 */
export function loadPromptBodies(env: Record<string, string | undefined>, cwd?: string): string[] {
  const bodies: string[] = []
  let files = 0
  for (const dir of promptDirs(env, cwd)) {
    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue
      if (files >= PROMPT_FILES_MAX) return bodies
      files++
      const raw = readSmallFile(join(dir, entry))
      const body = raw === null ? null : promptFileBody(raw)?.trim()
      if (body) bodies.push(body)
    }
  }
  return bodies
}

/**
 * Remove each exact occurrence of each body from `text`. The compare uses
 * LF line ends and trimmed bodies. A longer body goes first, so a body that
 * holds a shorter body is removed as one part.
 */
export function removePromptBodies(text: string, bodies: readonly string[]): string {
  let out = text.replace(/\r\n?/g, "\n")
  const clean = bodies
    .map((b) => b.replace(/\r\n?/g, "\n").trim())
    .filter((b) => b !== "")
    .sort((a, b) => b.length - a.length)
  for (const body of clean) out = out.split(body).join("")
  return out
}
