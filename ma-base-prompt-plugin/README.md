# ma-base-prompt-plugin

Provides the base system prompt (`systemPromptBase`, required): the neutral identity and the 3 system slots (`instructions`, `loopSafety`, `toolOutputConventions`), rendered from the core facts ctx.

- `prompts/`: the text, as data (`identity.neutral.md`, `instructions.md`, `loop-safety/*.md`, `tool-output-conventions.md`).
- `provider.ts`: default export makes a provider. It reads each file lazily, trims and keeps it, and fills `%%name%%` with a local `fill()`.
- `__fixtures__/`: the exact old core strings. Tests compare bytes against them.
- `core-parity.test.ts`: the files equal the core assets. Drop it when the core assets leave.
- Run: `bun run check` in this folder.
