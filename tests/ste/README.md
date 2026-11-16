# STE feedback loop

The prompt text in this repo goes to the model byte for byte. This folder keeps
that text in ASD-STE100 Simplified Technical English (STE), and it stops the
text from drifting back.

## The loop

```
edit a prompt  ->  bun run ste:strict   (see your findings)
              ->  fix the text
              ->  bun run ste:write    (record the lower count)
              ->  bun run ste:gate     (prove no file got worse)
```

## Commands

| Command              | What it does                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run ste:gate`   | Compare the tree with the baseline. Exit 1 when a file or a rule goes above its count.                                                              |
| `bun run ste:strict` | Print every finding at every surface. Exit 1 on any finding. Use it to see the work.                                                                |
| `bun run ste:report` | Write `ste-report.md`: the open debt, per rule and per file.                                                                                        |
| `bun run ste:write`  | Record today's counts as the new baseline. Required after a fix.                                                                                    |
| `bun run ste:parity` | Compare a rewritten file with git `HEAD` and list each protected token that disappeared: a number, a tag, a placeholder, a path, an env var, a URL. |
| `bun run test:ste`   | The test suite: rule self-tests and the corpus gate.                                                                                                |

## The surfaces

`tests/ste/surfaces.ts` collects every place a model can read:

- `ma-*-plugin/PROMPT.md`
- `ma-*-plugin/prompts/**.md`
- `ma-*-plugin/manifest.json` `description` values
- inline `systemPrompt:` and `description:` TS literals
- the core files that still hold model text: `context-compact.ts`,
  `mode-text.ts`, `modes.ts`, `system-prompt.ts`

A surface with an empty text is a finding (`ste-s11-empty-surface`), never a
silent skip.

## The rules

`tests/ste/ste-rules.ts` holds the rules. Each one has a stable id.

| Id                          | Rule                                                  | Severity      |
| --------------------------- | ----------------------------------------------------- | ------------- |
| `ste-s1-long-sentence`      | 20 words for an instruction, 25 for a description     | error or warn |
| `ste-s2-semicolon`          | no semicolon in prose                                 | error         |
| `ste-s3-typographic`        | no em dash, curly quote or ellipsis character         | error         |
| `ste-s4-banned-word`        | utilize, leverage, robust, ensure, prior to, moreover | error         |
| `ste-s5-phrasal-verb`       | turn on, find out, look at                            | warn          |
| `ste-s6-contraction`        | cannot, does not                                      | error         |
| `ste-s7-passive`            | active voice when the agent is known                  | warn          |
| `ste-s8-shout-case`         | ALWAYS, NEVER, IMPORTANT, ONLY                        | warn          |
| `ste-s9-sycophancy`         | filler, flattery, signposting                         | error         |
| `ste-s10-inconsistent-term` | one word for one meaning in a file                    | warn          |
| `ste-s11-empty-surface`     | an empty prompt file                                  | error         |

Code spans, tags, placeholders, paths, URLs and wire headers are masked before
the rules run. A model never reads them as prose, so they do not count.

Errors block a merge. Warnings record debt and are still counted by the
ratchet, because a warning is style debt the same way.

## The ratchet

`tests/ste/ste-baseline.json` holds a count for each `file` + `rule` pair. The
gate passes when no pair goes up and no new pair appears. A fix lowers a count
and `ste:write` records it, so the baseline only moves toward zero.

Two guards keep the ratchet honest:

- `ste:write` is the only way a number can grow. A reviewer sees that diff.
- The test suite fails when the baseline is above today's counts. A stale
  allowance cannot hide a fixed file, and the baseline cannot lag the tree.

## Where it runs

- `scripts/check.ts` runs `ste:gate` before the test step, so `bun run check`
  and CI both enforce it.
- `.husky/pre-commit` runs `ste:gate` when a commit touches a prompt or a
  manifest.
- `tests/ste/ste-corpus.test.ts` runs the same engine in the test suite, so a
  test run gives the same answer as the gate.

## Fixing text

Read `BRIEF.md`. It is the shared contract: the style rules, the list of facts
that must not change, and the check commands.
