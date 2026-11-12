# ma-prompt-template-plugin

Provides the `prompts.template` slot (`provides: ["prompts.template"]`, `required: true`).

- `template.ts`: the `%%name%%` / `%%name?%%` engine and `PromptTemplateError`.
- `provider.ts`: default export `createProvider()`. `render` reads `<pluginDir>/prompts/<name>` (memoized), fills vars, then `expand`.
- There is no escape syntax: a prompt cannot hold a literal `%%name%%` for a valid placeholder name, it is always substituted or reported as missing.
- `expand` is identity for now. The sideband pass lands with the codec step.
- `parity.test.ts` (C50): byte parity with the core engine over every prompt asset.
- Run: `bun run check` in this folder.
