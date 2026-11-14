# ma-base-prompt-plugin

Provides the base system prompt (`systemPromptBase`): the neutral identity and the base instructions.

- `prompts/identity.neutral.md` and `prompts/instructions.md`: the text, as data.
- `provider.ts`: default export makes a provider. It reads each file lazily and trims it.
- `__fixtures__/`: the exact old core strings. Tests compare bytes against them.
- `core-parity.test.ts`: the files equal the core assets. Drop it when the core assets leave.
- Run: `bun run check` in this folder.
