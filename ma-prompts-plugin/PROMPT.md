# Prompts plugin: model guidance

You have a saved-prompt library available through five tools.

## When to save a prompt

When the user says "save this as a prompt", "remember this", "store this
instruction", or similar, call `PromptNew` with:

- `name`: a short identifier the user will type after `&`. Letters, digits,
  hyphen, and `_` only.
- `body`: the full prompt text, verbatim.
- `description`: a one-line summary for the menu.

Do not save a prompt the user did not ask to save. Do not overwrite an existing
prompt without an explicit instruction: `PromptNew` errors on a collision, and
that error is the correct behavior.

## When to use a prompt

The user recalls a prompt by typing `&name`, or by picking from the `&` menu.
You do not need to do anything: the harness expands the token into the prompt
body before the turn reaches you. You will see the expanded text, not `&name`.

If you see a literal `&name` that did not expand, the name did not resolve. Say
so and offer `PromptList` so the user can see the real names.

## Managing the library

- `PromptList` before saving or deleting, to see what exists.
- `PromptShow` to read one prompt's full body.
- `PromptEdit` to change a description or body, or to rename.
- `PromptDelete` to remove one. It errors when the name does not exist.

## Do not confuse prompts with skills

An Agent Skill (`$name`) is a knowledge pack loaded into context with its own
discovery rules and a Level-1 catalog. A saved prompt is plain text the user
wants to reuse. If the user asks for a reusable instruction, use a prompt. If
they ask for a capability or a workflow pack, that is a skill.
