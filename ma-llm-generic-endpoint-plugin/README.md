# ma-llm-generic-endpoint-plugin

Generic endpoint provider for minimal-agent. It sends requests to any URL in
a registered wire surface format (today: `openai-chat-completions`), for
example a local runtime (LM Studio, vLLM, MLX) or a custom proxy. It has no
static model catalog: the model comes from `--model`.

## Config

Each value has a CLI flag and a `MINIMAL_AGENT_*` environment variable.
`config.ts` (`readGenericEndpointConfig`) reads the variables.

| Variable | Flag | Value |
|---|---|---|
| `MINIMAL_AGENT_ENDPOINT` | `--endpoint` | The endpoint URL. Necessary. |
| `MINIMAL_AGENT_FORMAT` (or `MINIMAL_AGENT_SURFACE`) | `--format` | The wire surface id. Necessary. |
| `MINIMAL_AGENT_PROVIDER_MODEL` | `--provider-model` | The model id on the wire, when it is not the `--model` id. |
| `MINIMAL_AGENT_EFFORT_LEVELS` | `--effort-levels` | A comma list of effort levels, for example `low,medium,high`. |
| `MINIMAL_AGENT_IMAGE_INPUT` | | `1`/`true`/`on`/`yes` or `0`/`false`/`off`/`no`. Absent: the codec decides. |
| `MINIMAL_AGENT_TOKENIZER` | | The tokenizer family for the token estimate. See below. |

## Token estimate

The plugin always gives the model a token estimator (from
`ma-token-estimate-kit`). The order:

1. `MINIMAL_AGENT_TOKENIZER`, when it is set.
2. The family of the model id, then of the provider model id.
3. The estimator of the codec, if the codec has one.
4. `generic`: the fit on 12 reference tokenizers.

`MINIMAL_AGENT_TOKENIZER` is a family name of the kit (case does not
change the result): `claude-legacy`, `claude-5x`, `openai-o200k`,
`openai-cl100k`, `gemma`, `llama3`, `llama4`, `qwen`, `deepseek`, `mistral`,
`glm`, `kimi`, `minimax`, `grok`, `meta-muse`, `generic`. An unknown name
throws an error when the plugin reads the config, and the error lists the
valid names.

Example: a local Qwen model with a model id that has no family name.

```sh
MINIMAL_AGENT_TOKENIZER=qwen minimal-agent --provider generic-endpoint \
  --model my-local-model \
  --format openai-chat-completions \
  --endpoint http://localhost:1234/v1/chat/completions
```
