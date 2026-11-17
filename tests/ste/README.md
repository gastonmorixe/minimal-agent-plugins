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

| Command              | What it does                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run ste:gate`   | Compare the tree with the baseline. Exit 1 when a file or a rule goes above its count.                                                                                                    |
| `bun run ste:strict` | Print every finding at every surface. Exit 1 on any finding. Use it to see the work.                                                                                                      |
| `bun run ste:report` | Write `ste-report.md`: the open debt, per rule and per file.                                                                                                                              |
| `bun run ste:write`  | Record today's counts as the new baseline. Required after a fix. Never a raise. `--introduce <rule-id>` records the prose debt of a new rule.                                             |
| `bun run ste:parity` | Compare a rewritten file with git `HEAD` and list each protected token that disappeared: a number, a tag, a placeholder, a path, an env var, a URL. `10s` and `10 s` are the same number. |
| `bun run test:ste`   | The test suite: rule self-tests and the corpus gate.                                                                                                                                      |

## The surfaces

`tests/ste/surfaces.ts` collects every place a model can read:

- `ma-*-plugin/PROMPT.md`
- `ma-*-plugin/prompts/**.md`
- `ma-*-plugin/manifest.json` `description` values
- inline `systemPrompt:` and `description:` TS literals
- the core files that still hold model text: `context-compact.ts`,
  `mode-text.ts`, `modes.ts`, `system-prompt.ts`, `binary-guard.ts`

Each surface has a role (`roleOf` in `surfaces.ts`):

- `tool`: a tool `description` (manifest locator ending in
  `.trigger.tool.description`, or `ma-core-tools-plugin/prompts/tools/*.md`).
- `param`: a parameter description (locator with `.input_schema.` or
  `PARAMS.`, or core `binary-guard.ts`).
- `prose`: everything else.

The tool block (roles `tool` and `param`) ships on every request. Every rule is
an error there, and no tool-block finding can enter the baseline.

A surface with an empty text is a finding (`ste-s11-empty-surface`), never a
silent skip.

## The rules

`tests/ste/ste-rules.ts` holds the rules. Each one has a stable id.

| Id                          | Rule                                                              | Prose severity |
| --------------------------- | ----------------------------------------------------------------- | -------------- |
| `ste-s1-long-sentence`      | 20 words for an instruction, 25 for a description                 | error or warn  |
| `ste-s2-semicolon`          | no semicolon in prose                                             | error          |
| `ste-s3-typographic`        | no em dash, curly quote or ellipsis character                     | error          |
| `ste-s4-banned-word`        | utilize, leverage, robust, ensure, prior to, moreover             | error          |
| `ste-s5-phrasal-verb`       | turn on, find out, look at                                        | warn           |
| `ste-s6-contraction`        | can't, don't, it's (write cannot, do not, it is)                  | error          |
| `ste-s7-passive`            | be + participle + by, can/must/will be + participle, is to be     | warn           |
| `ste-s8-shout-case`         | ALWAYS, NEVER, IMPORTANT, ONLY                                    | warn           |
| `ste-s9-sycophancy`         | filler, flattery, signposting                                     | error          |
| `ste-s10-inconsistent-term` | one word for one meaning in a file (all surfaces of the file)     | warn           |
| `ste-s11-empty-surface`     | an empty prompt file                                              | error          |
| `ste-s12-hidden-char`       | a character that is not on the per-file allowlist                 | error          |
| `ste-s13-paragraph`         | more than 6 sentences in a paragraph (a list item is a paragraph) | warn           |
| `ste-s14-abbreviation`      | e.g., i.e., etc., vs, approx., cf., w/o                           | error          |
| `ste-s15-slash`             | `word/word` for "or" or "and"                                     | warn           |
| `ste-s16-progressive`       | be + -ing (`is running`), an opening -ing clause                  | warn           |
| `ste-s17-modal`             | may, might, should, shall, would (`could` is a warning)           | error          |
| `ste-s18-fragment`          | starts with And/Or/But/So, or a verb with no subject (`Reads`)    | warn           |
| `ste-s19-dictionary`        | an approved word (rule 1.1), from `tests/ste/extra-rules.ts`      | error          |
| `ste-s20-tool-name`         | a tool is named by its wire name, from `tests/ste/extra-rules.ts` | error          |
| `ste-s21-result-verb`       | tool role only: the result sentence is "The tool gives ..."       | n/a            |

In the `tool` and `param` roles every rule is an error.

Code spans, tags, placeholders, paths, URLs and wire headers are masked before
the rules run. A model never reads them as prose, so they do not count.

Errors block a merge. Warnings record debt and are still counted by the
ratchet, because a warning is style debt the same way.

## The ratchet

`tests/ste/ste-baseline.json` holds a count for each `file` + `rule` pair. The
gate passes when no pair goes up and no new pair appears. A fix lowers a count
and `ste:write` records it, so the baseline only moves toward zero.

Guards that keep the ratchet honest:

- A tool-block finding (role `tool` or `param`) and a finding of a rule in
  `ZERO_TOLERANCE` (`ratchet.ts`) never enter the baseline. The gate reports
  each one as `zero-tolerance`.
- `ste:write` refuses to raise any pair above the merge base with
  `origin/main`. A NEW rule id records its prose debt once, with
  `bun run ste:write --introduce <rule-id>`. Other raises are not written.
- In CI (`CI` set), `ste:write` fails when it cannot read the merge-base
  baseline, unless `STE_SKIP_BASELINE_GUARD=1`.
- A rule in `PROMOTE_AT_ZERO` that has no baseline entry left must move to
  `ZERO_TOLERANCE`. A test forces the move.
- The test suite fails when the baseline is above today's counts. A stale
  allowance cannot hide a fixed file, and the baseline cannot lag the tree.
- `EXEMPT_SNIPPETS` exempts a finding only inside the quoted example (by
  offset), and a test fails when an example is gone from its file.

## Extra rules

`scripts/ste-check.ts` loads `tests/ste/extra-rules.ts` when it exists. Its
default export has the `ExtraFindings` signature of `ste-rules.ts`:
`({ masked, raw, lineOffset, file, role }) => SteFinding[]`. The gate calls it
once for each surface. The s19 dictionary and the s20 tool-name rules plug in
there.

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
