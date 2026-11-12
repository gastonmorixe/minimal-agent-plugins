# ma-prompt-template-plugin

Provides the `prompts.template` slot (`provides: ["prompts.template"]`, `required: true`).

- `template.ts`: the `%%name%%` / `%%name?%%` engine and `PromptTemplateError`.
- `provider.ts`: default export `createProvider()`. `render` reads `<pluginDir>/prompts/<name>` (memoized), fills vars, then `expand`.
- `expand` is identity for now. The sideband pass lands with the codec step.
- `parity.test.ts` (C50): byte parity with the core engine over every prompt asset.
- Run: `bun run check` in this folder.
