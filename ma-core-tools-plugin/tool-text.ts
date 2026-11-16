/**
 * Tool text provider (`text.tools`) for the 8 built-in tools. The
 * descriptions are data files (byte copies of core `src/prompts/tools/*.md`),
 * trimmed as core trims them. The param descriptions are byte copies of core
 * `TOOL_PARAM_DESCRIPTIONS`, keyed by the schema property name.
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
    command: "The command to execute",
    timeout: "Optional timeout in milliseconds (max 600000)",
    description: "Clear, concise description of what this command does",
  },
  Read: {
    file_path: "The absolute path to the file to read",
    offset: "Line number to start reading from",
    limit: "Number of lines to read",
  },
  Write: {
    file_path: "The absolute path to the file to write",
    content: "The content to write to the file. `contents` is accepted as an alias.",
    contents: "Alias for `content`. Same meaning; ignored when `content` is also set.",
  },
  Edit: {
    file_path: "The absolute path to the file to modify",
    old_string: "The text to replace",
    new_string: "The text to replace it with",
    replace_all: "Replace all occurrences (default false)",
  },
  Glob: {
    pattern: "The glob pattern to match files against. `glob_pattern` is accepted as an alias.",
    glob_pattern: "Alias for `pattern`. Same meaning; ignored when `pattern` is also set.",
    path: "Directory to search in. Defaults to cwd. `target_directory` is accepted as an alias.",
    target_directory: "Alias for `path`. Same meaning; ignored when `path` is also set.",
  },
  Grep: {
    pattern: "Regex pattern to search for",
    path: "File or directory to search in. Defaults to cwd.",
    glob: 'Glob pattern to filter files (e.g. "*.js")',
    output_mode: "Output mode: content, files_with_matches, or count",
    "-i": "Case insensitive search",
    "-n": "Show line numbers (default true)",
    "-A": "Lines after match",
    "-B": "Lines before match",
    "-C": "Context lines",
    context: "Context lines (alias for -C)",
    head_limit: "Limit output lines (default 250)",
    multiline: "Enable multiline mode",
  },
  FilesStats: {
    status: "Optional status filter: all, present, missing, or changed",
    path: "Optional absolute path or directory prefix filter",
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
