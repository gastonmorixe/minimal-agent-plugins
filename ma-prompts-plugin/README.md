# ma-prompts-plugin

Saved prompt library for minimal-agent.

Store reusable prompts, recall them with the `&` autocomplete menu, and expand
`&name` to the full prompt body when the turn is sent.

## What it does

- **Tools** for the model: `PromptNew`, `PromptList`, `PromptShow`,
  `PromptEdit`, `PromptDelete`. The user saves a prompt by telling the model to.
- **`&` menu**: type `&` in the message box and a fuzzy list of saved prompts
  opens. Same interaction and visual language as the `$` skill menu.
- **`&name` expansion**: typing `&name` (with or without the menu) expands to
  the prompt body on the model path at submit. Scrollback keeps the short form.

## Storage

One file per prompt under `<agent-home>/prompts/`, named `<slug>.md`:

```
---
name: review-pr
description: Review a pull request carefully
---
Read the diff and report: correctness, tests, and anything risky.
```

`<agent-home>` honors `MINIMAL_AGENT_HOME`, falling back to
`~/.minimal-agent`. An optional project scope (`<cwd>/.agents/prompts/`) is off
by default and shadows user prompts by name.

## Keys in the menu

| Key         | Action                                                  |
| ----------- | ------------------------------------------------------- |
| `↑` `↓`     | Move the selection                                      |
| `Tab`       | Complete the `&name` token, cursor ready to keep typing |
| `Enter`     | Insert the prompt NAME (`&review-pr`)                   |
| `Alt+Enter` | Insert the full prompt BODY at the caret                |
| `Esc`       | Close the menu, keep the buffer                         |

Enter inserts the name so a large prompt never floods the input box. Alt+Enter
expands it when the user wants the whole text. Both are expanded at submit
anyway, so either path reaches the model with the real instruction.

Alt+Enter only applies while the menu is open. When no menu is open it falls
through to the editor's normal newline insertion.

## Config

`~/.minimal-agent/config.jsonc`:

```jsonc
{
  "plugins": {
    "ma-prompts": {
      "enabled": true,
      "projectScope": false,
      "maxBodyBytes": 65536,
      "maxPrompts": 500,
      "sigil": "&"
    }
  }
}
```

Every field is optional. A malformed config falls back to the defaults rather
than crashing the agent.

## Layout

```
handlers/     tool handlers, key/buffer hooks, turn.willStart, prompt fragment
lib/          store, frontmatter, config, provider, rewrite, menu spec
```

The menu machinery (FSM, fuzzy scoring, ANSI rendering, style spans) lives in
the shared `ma-autocomplete-kit` package, not here. This plugin supplies the
`&` trigger spec and a provider.

## Tests

```
bun test
```

Store, rewrite, frontmatter, config, provider and tool-handler tests run with
injected deps and a temp directory. They never touch the real
`~/.minimal-agent/prompts`.
