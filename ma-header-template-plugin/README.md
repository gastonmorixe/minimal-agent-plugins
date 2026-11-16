# ma-header-template-plugin

Prints a custom header from a `%%name%%` template, instead of the startup
tree. Made for one-shot runs (`ma "question"`), where the tree is hidden
by default and the session id is otherwise lost.

```sh
ma --header-format '%%sid.short%% · %%model%% · %%effort%%\n  ↺ ma -r %%sid%%' "question"
```

```
5297afff · gpt-6-luna · low
  ↺ ma -r 5297afff-2fbe-43ee-aa3e-50d8c3fbcac1
```

## Setting the template

First match wins:

1. `--no-header`: off.
2. `--header-format '<template>'`
3. `MINIMAL_AGENT_HEADER_FORMAT`
4. `headerFormat` in `~/.minimal-agent/config.jsonc`

When a template is set, the CLI hides the startup tree (`--header` still
forces it) and passes the template to this plugin in
`MINIMAL_AGENT_HEADER_FORMAT`. The CLI has no template logic.

The plugin prints once, on the first `session.willStart`, to stderr, so
`ma "q" | pbcopy` still gets only the answer.

## Syntax

The shared `%%name%%` grammar from `ma-template-kit`:

- `%%name%%` is required. No value prints one error line instead of the header.
- `%%name?%%` is optional. No value prints nothing.
- A literal `\n` in the template is a line break.

## Variables

| Name                                      | Value                                               |
| ----------------------------------------- | --------------------------------------------------- |
| `sid` / `sid.short`                       | Session id, full / first 8 chars                    |
| `source`                                  | `startup`, `resume`, `clear`, `compact`             |
| `model`, `provider`                       | Model id, provider id                               |
| `effort`                                  | Resolved effort level                               |
| `agent`                                   | Agent name (`MINIMAL_AGENT_AGENT_NAME`)             |
| `version`, `pid`                          | minimal-agent version, process id                   |
| `cwd`, `cwd.tilde`, `cwd.base`            | Working dir: absolute, `~/...`, last component      |
| `branch`                                  | Git branch. Runs git only when used                 |
| `time`, `date`                            | `HH:MM`, `YYYY-MM-DD`                               |
| `c.dim`, `c.bold`, `c.reset`, `c.<color>` | ANSI styles. Empty without a TTY or with `NO_COLOR` |

Colors: `red green yellow blue magenta cyan gray pink lime sky`, plus
`italic`. A reset is added at the end of the header.

## Files

| File                                | Role                                   |
| ----------------------------------- | -------------------------------------- |
| `handlers/on_session_will_start.ts` | Reads the template, prints the header  |
| `lib/render.ts`                     | Pure render, error line, `\n` handling |
| `lib/vars.ts`                       | Lazy variable map                      |
