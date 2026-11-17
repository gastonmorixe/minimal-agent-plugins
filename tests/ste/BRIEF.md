# STE fix brief

Read this before you edit one file. It is the shared contract for every STE fix
worker.

## Goal

Rewrite model-facing prompt text in ASD-STE100 Simplified Technical English.
Keep the meaning exact. Change style, not facts.

## Rules

1. One word, one meaning. Use the same word for the same thing in all files.
2. Instruction sentence: 20 words maximum. Descriptive sentence: 25 words maximum.
3. One idea per sentence. Split a long sentence into two sentences.
4. Active voice. Use the imperative for an instruction to the model.
5. No semicolon in prose. Write two sentences.
6. No contraction. Write cannot, does not, it is.
7. No idiom, slang or metaphor.
8. No shout case (ALWAYS, NEVER, IMPORTANT, ONLY, REQUIRED). The rule keywords
   `MUST` and `SHOULD` stay, but only in a numbered rule line such as
   `INS-01 MUST ...`.
9. Plain words: use, help, fix, show, make, start, stop, examine.
   Replace: utilize -> use, leverage -> use, facilitate -> help,
   robust -> reliable, seamless -> smooth, ensure -> make sure,
   commence/initiate -> start, prior to -> before, in order to -> to.
   Drop: moreover, furthermore, additionally.
10. No phrasal verb: turn on -> set, find out -> find, look at -> examine.
11. Plain ASCII punctuation. No em dash, en dash, curly quote or ellipsis
    character.
12. Use "you" for the model, "the user" for the human, "the harness" for the
    program.
13. No abbreviation: e.g. -> for example, i.e. -> that is, etc. -> name the
    items, vs -> or.
14. Modals: may/might -> can or possibly, should/shall -> must, would -> can.
15. No slash for "or": `a/b` -> `a or b`. A path, URL or unit stays.
16. No progressive: `is running` -> `runs`. No opening -ing clause.
17. A paragraph has 6 sentences or fewer. Make a list for more.
18. A sentence has a subject or is an imperative. Do not start with And, Or,
    But or So. A tool description opens with an imperative ("Read a file.").
19. Tool role: the result sentence is "The tool gives ...".

The tool block (tool and param descriptions) is zero-tolerance: every finding
there is an error and none can enter the baseline.

## Do not change

- Tool names, parameter names, JSON keys, enum values, kind names.
- Tag text and attributes: `<ma::agent::...>`, `<ma::... />`.
- Placeholders: `%%name%%`, `${...}`, `<session_id>`.
- Paths, env vars, shell code, units, numbers, limits, defaults.
- A `manifest.json` `description` field key or any other JSON key.
- Test files, fixtures, goldens.

## Where the rules live

- Rule engine: `tests/ste/ste-rules.ts`
- Surfaces: `tests/ste/surfaces.ts`
- Gate: `bun run ste:strict` prints every finding as `file:line rule: message`.

## Checks before you finish

```
cd /Users/user/Projects/minimal-agent-monorepo/minimal-agent-plugins
bun run ste:strict 2>&1 | grep '<your files>'
bun run ste:write            # record the lower counts
bun test tests/ste
bun run typecheck
bun run lint
bun run format:check
```

`bun run ste:write` is required after a fix. The ratchet fails when the
baseline is above the real count, on purpose.

Do not run `bun run test` for the whole repo. It needs a golden regeneration
that the lead does. Run the tests of the plugin you changed, and only when they
exist:

```
bun test ./ma-<plugin>/       # if that folder has .test.ts files
```

## Report

Report these items, and nothing else:

1. Each file you changed, with the number of findings before and after.
2. Any fact that you had to keep, and why (a number, a tag, a key).
3. Any finding that you did not fix, and why.
4. The exit code of each check you ran.
