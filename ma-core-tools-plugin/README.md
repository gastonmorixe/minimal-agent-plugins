# ma-core-tools-plugin

Owns the model-facing text of the 8 built-in tools (Bash, Read, Write, Edit, Glob, Grep,
FilesStats, Mode). Core keeps the tool code and the input schemas. The plugin is `required`.

## Contributions

- `provider.ts`: the one entry module of both contributions (it re-exports both factories).
- `toolText` (`tool-text.ts`, contract `text.tools`): the description of each tool and of each
  param. Descriptions are data files in `prompts/tools/*.md`, loaded with a text import and
  trimmed. Param keys are the schema property names (`-i`, `head_limit`, ...).
- `syntheticText` (`synthetic-text.ts`): 36 kinds.
  - `tool_output.preview` `{shown, total, tool, bash, rawPath?}`: the
    `<ma::agent::output-preview>` tag with its hint.
  - `tool_output.truncated` `{tool, shownBytes, totalBytes, shownLines, totalLines, cutLine,
    maxToolOutputBytes}`: the `[truncated: ...]` notice with its per-tool hint.
  - `tool_output.streak` `{tool, threshold}`.
  - all 30 `tool_text.<Tool>.*` kinds (facts in plugin-api `types/synthetic-text.ts`).
  - `mode.refusal` `{tool, modeId, label, hint?}`, `mode.active_stamp` `{id, since}`,
    `mode.change` `{from, to, at}`.

Each text is built from its facts only. A missing fact or a kind it does not own throws. The core
resolver catches the throw, uses its own text and records a diagnostic. `detail` facts carry the
raw error message until spec Phase 11. `formatBytes` is an exact copy of core `media/types.ts`.

## Tests

- `parity.test.ts`: `buildToolDefinitions([provider])` equals the captured `tools.json` bytes,
  and every `synthetic.json` entry of an owned kind runs through the real core helper with this
  provider and gives the fixture text.
- `manifest.test.ts`: the provider lists equal the manifest lists, and the loader loads it with no
  mismatch diagnostic.
- Run: `bun test ma-core-tools-plugin` in `minimal-agent-plugins`.
