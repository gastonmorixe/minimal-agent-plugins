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
    command: "The command to run",
    timeout: "Optional timeout in milliseconds (maximum 600000)",
    description: "A clear, short description of what the command does",
  },
  Read: {
    file_path: "The absolute path to the file to read",
    offset: "The line number where the read starts",
    limit: "The number of lines to read",
  },
  Write: {
    file_path: "The absolute path to the file to write",
    content: "The text to write to the file. You can also use the alias `contents`.",
    contents:
      "Alias for `content`, with the same meaning. If `content` is also set, the tool ignores this alias.",
  },
  Edit: {
    file_path: "The absolute path to the file to change",
    old_string: "The text to replace",
    new_string: "The replacement text",
    replace_all: "Replace all occurrences (default false)",
  },
  Glob: {
    pattern:
      "The glob pattern that the file paths must match. You can also use the alias `glob_pattern`.",
    glob_pattern:
      "Alias for `pattern`, with the same meaning. If `pattern` is also set, the tool ignores this alias.",
    path: "The directory to search. The default is cwd. You can also use the alias `target_directory`.",
    target_directory:
      "Alias for `path`, with the same meaning. If `path` is also set, the tool ignores this alias.",
  },
  Grep: {
    pattern: "The regex pattern to find",
    path: "The file or directory to search. The default is cwd.",
    glob: 'A glob pattern that selects the files to search (for example, "*.js")',
    output_mode: "The output mode: content, files_with_matches or count",
    "-i": "Ignore letter case in the search",
    "-n": "Show line numbers (default true)",
    "-A": "The number of lines to show after each match",
    "-B": "The number of lines to show before each match",
    "-C": "The number of context lines to show before and after each match",
    context: "The number of context lines (alias for -C)",
    head_limit: "The maximum number of output lines (default 250)",
    multiline: "Set multiline mode",
  },
  FilesStats: {
    status: "Optional filter by status: all, present, missing or changed",
    path: "Optional filter by an absolute path or a directory prefix",
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
