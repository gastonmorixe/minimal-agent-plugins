# ma-base-prompt-plugin

Provides the base system prompt (`systemPromptBase`, required): the neutral identity and the `instructions` slot, rendered from the core facts ctx. The opt-in reflection checkpoint text is in `ma-reflection-checkpoint-plugin`.

- `prompts/`: the text, as data (`identity.neutral.md`, `instructions.md`).
- `provider.ts`: default export makes a provider. It reads each file lazily, trims and keeps it, and fills `%%name%%` with a local `fill()`.
- `__fixtures__/`: the exact old core strings. Tests compare bytes against them.
- This plugin is the only owner of this text. Core holds no copy. `provider.test.ts` checks the bytes against `tests/text-parity/fixtures/system.json`.
- Run: `bun run check` in this folder.
