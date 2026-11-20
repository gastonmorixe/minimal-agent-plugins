/**
 * Tool text provider (`text.tools`) for the 8 built-in tools. The
 * descriptions are data files in `prompts/tools/*.md`, trimmed as core trims
 * them. The param descriptions are keyed by the schema property name. The
 * texts are the STE rewrite (P4) of the old core texts
 * (tests/text-parity/fixtures/tools.json). parity.test.ts pins the new texts.
 *
 * @module ma-core-tools-plugin/tool-text
 */

import type {
  BuiltinToolText,
  ToolTextProvider,
} from "@minimal-agent/core/plugin-api/types/tool-text"

import bashMd from "./prompts/tools/bash.md" with { type: "text" }
import editMd from "./prompts/tools/edit.md" with { type: "text" }
import filesStatsMd from "./prompts/tools/files-stats.md" with { type: "text" }
import globMd from "./prompts/tools/glob.md" with { type: "text" }
import grepMd from "./prompts/tools/grep.md" with { type: "text" }
import modeMd from "./prompts/tools/mode.md" with { type: "text" }
import readMd from "./prompts/tools/read.md" with { type: "text" }
import writeMd from "./prompts/tools/write.md" with { type: "text" }

/** The built-in tool names this plugin owns, in request order. */
export const TOOLS: readonly string[] = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "FilesStats",
  "Mode",
]

/** Param descriptions per tool, keyed by the schema property name. */
const PARAMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Bash: {
    command: "The command to run.",
    timeout: "Optional. The time limit in milliseconds: default 120000, maximum 600000.",
    description: "A short description of the command.",
  },
  Read: {
    file_path: "The full path of the file to read.",
    offset: "The zero-based index of the first line. Line 1 is index 0.",
    limit: "The number of lines to read.",
  },
  Write: {
    file_path: "The full path of the file to write.",
    content: "The text to write to the file. You can also use the alias `contents`.",
    contents: "An alias for `content`. If `content` has a value, the tool ignores this alias.",
  },
  Edit: {
    file_path: "The full path.",
    old_string: "The same text as in the file.",
    new_string: "The replacement.",
    replace_all: "`true` replaces all. The default is `false`.",
  },
  Glob: {
    pattern: "The glob pattern for the file paths. You can also use the alias `glob_pattern`.",
    glob_pattern: "An alias for `pattern`. If `pattern` has a value, the tool ignores this alias.",
    path: "The directory to examine. The default is the cwd. You can also use the alias `target_directory`.",
    target_directory: "An alias for `path`. If `path` has a value, the tool ignores this alias.",
  },
  Grep: {
    pattern: "The regex pattern to find.",
    path: "The file or directory to examine. The default is the cwd.",
    glob: 'A glob pattern that selects the files, for example `"*.js"`.',
    output_mode: "`files_with_matches` (default), `content` or `count`.",
    "-i": "If `true`, `A` and `a` are the same letter.",
    "-n": "The tool ignores this value. The `content` output always has line numbers.",
    "-A": "The number of lines to show after each line that agrees.",
    "-B": "The number of lines to show before each line that agrees.",
    "-C": "The number of lines to show before and after each line that agrees.",
    context: "An alias for `-C`.",
    head_limit: "The maximum number of output lines. The default is 250.",
    multiline: "If `true`, a pattern can agree with more than one line.",
  },
  FilesStats: {
    status:
      "Optional. Show only the files with this status: `all`, `present`, `missing` or `changed`.",
    path: "Optional. Show only the files with this full path or with this directory prefix.",
  },
  Mode: {},
}

/** Raw description markdown per tool. Core trims the file text, so do we. */
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  Bash: bashMd,
  Read: readMd,
  Write: writeMd,
  Edit: editMd,
  Glob: globMd,
  Grep: grepMd,
  FilesStats: filesStatsMd,
  Mode: modeMd,
}

/** Create the provider. `tool()` returns undefined for a name it does not own. */
export function createCoreToolTextProvider(): ToolTextProvider {
  const cache = new Map<string, BuiltinToolText>()
  return {
    tools: TOOLS,
    tool(name: string): BuiltinToolText | undefined {
      const hit = cache.get(name)
      if (hit) return hit
      const raw = Object.hasOwn(DESCRIPTIONS, name) ? DESCRIPTIONS[name] : undefined
      const params = Object.hasOwn(PARAMS, name) ? PARAMS[name] : undefined
      if (raw === undefined || params === undefined) return undefined
      const text: BuiltinToolText = { description: raw.trim(), params }
      cache.set(name, text)
      return text
    },
  }
}
