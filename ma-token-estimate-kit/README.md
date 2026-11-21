# ma-token-estimate-kit

Token-estimate presets for the LLM provider plugins. It is not a plugin.
Plugins import it with a relative path (`../ma-token-estimate-kit/src/index.ts`).

The kit holds data and small pure functions only. The estimator is the core
`makeCharClassEstimator` from `@minimal-agent/core/plugin-api/llm/token-estimate`.

## API

- `TOKENIZER_PRESETS[family]`: the `CharClassEstimatorParams` of a family.
  Each family also has a named constant (`CLAUDE_5X_PARAMS`, `QWEN_PARAMS`, ...).
- `familyForModelId(modelId)`: the tokenizer family of a model id, or `undefined`.
- `estimatorForFamily(family)`: the estimator of a family (memoized).
- `estimatorForModelId(modelId, fallbackFamily?)`: the two steps together.

## Family map

1. Lowercase the id. Remove aggregator prefixes: `openrouter/`,
   `accounts/fireworks/models/`, `fireworks/`, `together/`, `cline-pass/`,
   `opencode/`, `opencode-go/`, `opencode-zen/`.
2. Split `org/name` at the last `/` (also a Hugging Face cache name
   `org--name`). Remove an Ollama tag (`:120b`).
3. Name rules (the first rule that agrees wins). A `cursor-` prefix is removed
   when the rest agrees with a rule.

| name | family |
|---|---|
| `claude-*`, version 4.7 and later (all 5.x) | `claude-5x` |
| `claude-*`, version 4.6 and earlier | `claude-legacy` |
| `gpt-4` (not `gpt-4o`), `gpt-3.5*` | `openai-cl100k` |
| `gpt-*`, `chatgpt-*`, `codex-*`, `o1`, `o3`, `o4*`, `gpt-oss*` | `openai-o200k` |
| `gemini*`, `gemma*` | `gemma` |
| `muse-*` | `meta-muse` |
| `*llama-4*` / `*llama-3*` (also `llama3.1`) | `llama4` / `llama3` |
| `qwen*`, `qwq*` | `qwen` |
| `deepseek*` | `deepseek` |
| `mistral*`, `devstral*`, `codestral*`, `magistral*`, `ministral*`, `mixtral*`, `pixtral*` | `mistral` |
| `glm*`, `chatglm*` | `glm` |
| `kimi*`, `moonshot*` | `kimi` |
| `minimax*` | `minimax` |
| `grok*` | `grok` |

4. Else the org: `openai`, `google`, `meta-llama`, `qwen`, `deepseek(-ai)`,
   `mistralai`, `z-ai`/`zai-org`/`thudm`, `moonshotai`, `minimax(ai)`, `x-ai`/`xai`.
5. Else `undefined` (for example `cursor-auto`, `mimo-*`, `nemotron-*`). Use
   the `fallbackFamily` argument (for example `"generic"`) when a count is
   necessary.

## Calibration

MAPE is the mean absolute percentage error on the held-out samples (20%).
"Before" is the old fixed ratio: 3.5 chars/token for Anthropic and Grok, 4 for
OpenAI, 3.8 for all others. "After" is the real core estimator with the preset.

| family | data | samples (held out) | MAPE before % | MAPE after % |
|---|---|---|---|---|
| claude-5x | Anthropic sessions (Claude 4.7+ and 5.x) | 1502 (290) | 34.9 | 9.8 |
| claude-legacy | derived: `claude-5x` scale / 1.2 (see note) | 128 (22) | 31.5 | 12.7 (all 128) |
| openai-o200k | o200k_base tokenizer | 562 (113) | 14.9 | 5.3 |
| openai-cl100k | cl100k_base tokenizer | 562 (113) | 16.9 | 5.1 |
| gemma | Gemma 3 tokenizer (also Gemini: no Gemini data) | 562 (113) | 19.6 | 4.5 |
| llama3 | Llama 3.3 tokenizer | 562 (113) | 13.4 | 5.4 |
| llama4 | Llama 4 tokenizer | 562 (113) | 13.9 | 5.6 |
| qwen | Qwen3 tokenizer | 562 (113) | 15.7 | 4.7 |
| deepseek | DeepSeek-V3.1 tokenizer | 562 (113) | 14.3 | 4.3 |
| mistral | Tekken (Devstral) tokenizer | 562 (113) | 17.3 | 5.5 |
| glm | GLM-4.6 tokenizer | 562 (113) | 14.0 | 5.0 |
| kimi | Kimi K2 tokenizer | 562 (113) | 14.4 | 5.7 |
| minimax | MiniMax-M2 tokenizer | 562 (113) | 13.1 | 5.3 |
| grok | xAI sessions (grok-4.x) | 1500 (349) | 15.5 | 10.8 |
| meta-muse | Meta and OpenCode sessions (muse-*) | 1501 (257) | 17.5 | 14.8 |
| generic | union of the 12 reference tokenizers | 6744 (1356) | 15.2 | 7.3 |

Notes:

- Reference corpus: 562 chunks of code, markdown, JSON, tool schemas, agent
  tool results, prose in 9 languages and emoji. Each chunk has the exact count
  of the public tokenizer of each family. The Grok-2 tokenizer fit is
  4.8% (before 16.9%), but `grok` uses the live grok-4.x session data.
- Session samples: the input-token delta between two assistant turns, minus
  the previous output tokens, over the tool-result text between them (more
  than 8000 chars, no user or note record between, no thinking in the
  previous turn). For Anthropic the total input is
  `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
  (disjoint counters). For all other providers `input_tokens` includes the
  cached tokens. The split is by session file. The session families take the
  CJK and other weights from the generic fit.
- Claude 5.x: the fit uses text content, not request JSON. The net-dbg
  request JSON gives about 2.5 bytes/token; the text content gives about
  2.3 chars/token.
- claude-legacy: there is too little local data for a fit. Anthropic
  publishes that the new tokenizer gives about 1.0x to 1.35x more tokens. The
  preset divides the `claude-5x` scale by 1.2. On the 128 local Claude 4.5 and
  4.6 samples this gives MAPE 12.7% (bias -0.1%).

## Reference corpus

The reference corpus is a JSONL file of about 560 mixed text chunks: code,
markdown docs, JSON, tool schemas, agent tool results, prose in 9 languages
and emoji. Each chunk has the exact token count of each tokenizer family. The
counts come from the public tokenizer files of each family.

The calibration script reads one record for each (family, chunk) on each line:

```json
{ "family": "qwen", "kind": "code", "text": "...", "tokens": 123 }
```

- `family`: the kit family name (`llama` is read as `llama3`).
- `kind`: a free label of the chunk type, for example `code` or `prose`. Do
  not use `session`: the script keeps that label for session samples.
- `text`: the chunk text.
- `tokens`: the exact token count, more than 0.

The chunks must be in the same sequence in each family, because the script
uses the chunk index to select the held-out test set (each fifth chunk).

The corpus is not in the repo, and the tool that made it is not in the repo,
because it uses external tokenizer libraries (the project has no external
dependencies). The fitted parameters are in `src/presets.ts`, and the table
above gives the fit numbers. Without the corpus, you can fit the presets again
from session data only: give `--sessions` and do not give `--ref`. Then the
session families use `cjk=1` and `other=1`, because the CJK and other weights
come from the generic fit on the reference corpus.

## Run the calibration again

The input data is outside the repo. Do not commit it.

```sh
bun run scripts/token-estimate-calibrate.ts \
  --ref <ref.jsonl> \
  --sessions ~/.minimal-agent/sessions \
  --net-dbg ~/.minimal-agent/net-dbg \
  --json <fit.json>
```

- `--ref`: optional; the reference corpus JSONL (see
  [Reference corpus](#reference-corpus)).
- `--sessions`: minimal-agent session files (Claude, Grok and Muse samples).
- `--net-dbg`: optional; prints the Anthropic request-JSON bytes/token only.
- `--max-session-samples N`: the limit for each session family (default 1500).
- `--json FILE`: writes the fitted params.

The script prints a markdown table. It runs in about 20 seconds. Copy the
params into `src/presets.ts` and the numbers into this table.
