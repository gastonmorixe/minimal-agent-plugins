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
    timeout:
      "Optional. The time limit for the command, in milliseconds. The default is 120000. The tool sets no maximum.",
    description: "A short description of the command.",
  },
  Read: {
    file_path: "The full path of the file to read.",
    offset: "The line number where the read starts. The first line is 0.",
    limit: "The number of lines to read.",
  },
  Write: {
    file_path: "The full path of the file to write.",
    content: "The text to write to the file. You can also use the alias `contents`.",
    contents:
      "An alias for `content`, with the same function. If `content` has a value, the tool ignores this alias.",
  },
  Edit: {
    file_path: "The full path of the file to change.",
    old_string: "The text to replace.",
    new_string: "The replacement text.",
    replace_all:
      "If `true`, the tool replaces all of the text that is the same as `old_string`. The default is `false`.",
  },
  Glob: {
    pattern:
      "The glob pattern. The file paths must agree with this pattern. You can also use the alias `glob_pattern`.",
    glob_pattern:
      "An alias for `pattern`, with the same function. If `pattern` has a value, the tool ignores this alias.",
    path: "The directory to examine. The default is cwd. You can also use the alias `target_directory`.",
    target_directory:
      "An alias for `path`, with the same function. If `path` has a value, the tool ignores this alias.",
  },
  Grep: {
    pattern: "The regex pattern to find.",
    path: "The file or directory to examine. The default is cwd.",
    glob: 'A glob pattern that selects the files to examine. For example, `"*.js"`.',
    output_mode: "The output mode: `content`, `files_with_matches` or `count`.",
    "-i": "If `true`, the tool finds `A` and `a` as the same letter.",
    "-n":
      "Line numbers. The tool ignores this value. In `content` mode, the output always has line numbers.",
    "-A": "The number of lines to show after each line that agrees with the pattern.",
    "-B": "The number of lines to show before each line that agrees with the pattern.",
    "-C":
      "The number of context lines to show before and after each line that agrees with the pattern.",
    context: "The number of context lines. This is an alias for `-C`.",
    head_limit: "The maximum number of output lines. The default is 250.",
    multiline: "If `true`, a pattern can agree with text on more than one line.",
  },
  FilesStats: {
    status: "Optional. A filter by status: `all`, `present`, `missing` or `changed`.",
    path: "Optional. A filter by a full path or by a directory prefix.",
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
