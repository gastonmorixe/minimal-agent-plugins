# Fleet token count (contextSize, not billed integral)

Date: 2026-10-04
Plugin: `ma-sub-agents-plugin`
Authors: Donna (`fcc46867`), Matthew (`68a0d8fb`)
Status: patched and tested in this plugin. Cache overspend is a later wave.

## What the widget shows now

`Progress.tokens` is last-turn **contextSize**:

```
input_tokens + cache_read_input_tokens + cache_creation_input_tokens
```

Replace, do not accumulate. Each new assistant `usage` overwrites the previous value. A turn with no `usage` keeps the last footprint.

`fleetStats.tokens` sums those last footprints across running, done, and incomplete workers. That is concurrent window size, not `turns × context`.

Output tokens are not in the window. Cursor reports output as 0 anyway.

Code:

- `lib/progress.ts` `parseProgress`
- `lib/types.ts` `Progress.tokens`, `fleetStats`
- Host analog: `minimal-agent-core/src/session/session-tokens.ts` `contextSize`

## What it showed before (the bug)

`parseProgress` did `tokens += input + output` on every assistant turn. The comment called that the honest billed total and excluded cache reads so they would not inflate the sum.

That sum is `∫ context dt` when `input_tokens` is an absolute conversation size. The fleet widget and `fmtTokens` then printed `248k` / `2.76M` in under a minute.

Tests pinned the old sum: two turns `1000+200` and `1500+120` expected `2820`.

## Live evidence (2026-10-04)

### Cursor worker A5 (gpg-pinentry)

Session `d08b3a0c-3880-431f-99c8-c57cf83b5b4d`. Lead Sara `554e8a47`.

| turn | stored `input_tokens` | output | cache |
| --- | ---: | ---: | ---: |
| 1 | 31689 | 0 | 0 |
| 2 | 35205 | 0 | 0 |
| 3 | 35455 | 0 | 0 |
| 4 | 36008 | 0 | 0 |
| 5 | 36125 | 0 | 0 |
| 6 | 36633 | 0 | 0 |
| 7 | 36718 | 0 | 0 |
| **old widget sum** | **247833** (`248k`) | | |
| **new headline** | **36718** | | |

7 JSONL assistant turns. **One** `AgentService/Run` body (217675 bytes) in net-dbg. Tool results stayed on the open bidi stream. The 248k figure was not 7 prefills.

### Cursor explorers (this investigation)

| worker | tools | old sum | last context | Runs |
| --- | ---: | ---: | ---: | --- |
| `dc78104e` | 14 | 545645 | 42893 | 3 bodies 235k / 263k / 269k |
| `9a704733` | 48 | 2761402 | 90724 | 3 bodies 236k / 477k / 496k |

Identical `input_tokens` repeated across consecutive turns is the fingerprint of absolute size copied every round.

### Meta (Matthew, session `68a0d8fb`)

On Meta, `input_tokens` is per-turn prefill and `output_tokens` is real. Cache read is reported as `cached_tokens`.

| session | turns | input sum | last input | cache read sum |
| --- | ---: | ---: | ---: | ---: |
| lead `68a0d8fb` | 32 | 2186163 | 98252 (read 69105) | 223270 ~10% |
| worker `e26fb1a2` | 7 | 373615 | 59219 | 4721 ~1% |
| worker `60addf8d` | 6 | 297134 | 53126 (read 44145) | 44145 ~15% |

Old fleet display: 2 running showed 243k as A1 199k plus A2 44.5k. True last windows were ~50k to 98k. Factor about 4 to 5.

The old sum on Meta is closer to billed work than on Cursor. It is still not footprint. Headline is footprint.

## Provider mapping (why Cursor inflates harder)

| provider | what `input_tokens` means | cache fields | old widget |
| --- | --- | --- | --- |
| Cursor | `conversation_checkpoint_update.used_tokens` (absolute size). `cursor-usage.ts` maps that to `inputTokens`. Output always 0. | not mapped | `turns × used_tokens` |
| Meta / OpenAI / Grok | per-turn prefill. Output is real. | `cached_tokens` to `cacheRead` | sum of prefills (billed-ish, still not window) |
| Anthropic host path | new input plus disjoint cache read/create | explicit `cache_control` | same integral if summed |

Cursor carry (`conversation-carry.ts`) is the analog of a prompt cache. Worker sids in the Cursor samples had **no** `cursor-carry/*.json`. The lead Sara file was 1.1MB. `planCursorCarry` refuses a tail that contains tool blocks, so a fresh Run after a tool loop folds history.

Cache overspend (fresh isolation, prefix churn, missing carry) is **not** this patch.

## Consensus (Donna + Matthew, intercom 2026-10-04)

1. Headline: last-turn contextSize. Replace, do not accumulate.
2. ContextSize: `input + cacheRead + cacheCreate`. Matches host `session-tokens.ts`.
3. Fleet footer: sum of those last footprints across workers (concurrent windows). Not max. Not the integral.
4. Optional billed growth sum (`max(0, input_t - input_{t-1}) + output`) stays out of this patch.
5. Cache miss / fresh-prefix cost stays a later wave.

Matthew's `findings.md`: `research/2026-10-04-subagent-bugs/findings.md`.
Donna's audit: `research/2026-10-04-subagent-fleet-token-count.md` (monorepo).

## What this patch does not do

- Does not change Cursor `cursor-usage.ts` (still no cache counters, still no output).
- Does not persist tokens on `stopped` / `failed` handles (`fleetStats` still adds 0 there).
- Does not show a second billed number.
- Does not fix extra `AgentService/Run` folds when the bidi wire drops.
- Does not make `fresh` workers share the lead prefix.

## Tests

`ma-sub-agents-plugin`:

- last of two turns is 1500, not 2820
- last turn with cache is `1200 + 9000 + 300`
- full package: 293 pass, 0 fail (`bun test`, 2026-10-04)
