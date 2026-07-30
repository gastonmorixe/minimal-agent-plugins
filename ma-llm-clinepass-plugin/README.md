# ma-llm-clinepass-plugin

ClinePass provider for minimal-agent. Talks to Cline's OpenAI-compatible gateway
at `https://api.cline.bot/api/v1` and registers the subscription open-weight
catalog (`cline-pass/*`).

## Auth

1. **API key (simplest for third-party clients)**  
   Create at [app.cline.bot](https://app.cline.bot) → Account → API Keys.  
   Login via the host provider login flow, or set `CLINE_API_KEY` /
   `MINIMAL_AGENT_CLINEPASS_API_KEY` for session probes.

2. **WorkOS device-code OAuth (preferred interactive)**  
   Same flow as Cline CLI: WorkOS device PIN → Cline `/api/v1/auth/register` →
   refresh via `/api/v1/auth/refresh`. No localhost callback required.

You need an **active ClinePass subscription** for `cline-pass/*` model IDs.
Without it the gateway returns a not-subscribed error (plugin surfaces the
dashboard subscribe URL).

## Models

| Model             | ID                             |
| ----------------- | ------------------------------ |
| GLM 5.2           | `cline-pass/glm-5.2`           |
| Kimi K3           | `cline-pass/kimi-k3`           |
| Kimi K2.7 Code    | `cline-pass/kimi-k2.7-code`    |
| Kimi K2.6         | `cline-pass/kimi-k2.6`         |
| DeepSeek V4 Pro   | `cline-pass/deepseek-v4-pro`   |
| DeepSeek V4 Flash | `cline-pass/deepseek-v4-flash` |
| MiniMax M3        | `cline-pass/minimax-m3`        |
| MiMo V2.5 Pro     | `cline-pass/mimo-v2.5-pro`     |
| MiMo V2.5         | `cline-pass/mimo-v2.5`         |
| Qwen3.7 Max       | `cline-pass/qwen3.7-max`       |
| Qwen3.7 Plus      | `cline-pass/qwen3.7-plus`      |

Wire format: OpenAI Chat Completions (`POST /api/v1/chat/completions`), SSE stream.
Reasoning may appear as `delta.reasoning`. Reference pricing is subscription
quota metering only (not pay-per-token).

## Endpoints used

| Purpose         | URL                                                            |
| --------------- | -------------------------------------------------------------- |
| Chat            | `POST https://api.cline.bot/api/v1/chat/completions`           |
| Device auth     | `POST https://api.workos.com/user_management/authorize/device` |
| Device poll     | `POST https://api.workos.com/user_management/authenticate`     |
| Register tokens | `POST https://api.cline.bot/api/v1/auth/register`              |
| Refresh         | `POST https://api.cline.bot/api/v1/auth/refresh`               |
| Me / plan       | `GET .../api/v1/users/me`, `.../me/plan`                       |
| Balance / usage | `GET .../api/v1/users/{id}/balance`, `.../usages`              |

## Install

Package lives under `minimal-agent-plugins/ma-llm-clinepass-plugin` and is
workspace-globbed as `ma-*-plugin`. Symlink into the agent plugin root:

```bash
ln -sf "$(pwd)/ma-llm-clinepass-plugin" ~/.agents/plugins/ma-llm-clinepass-plugin
```

Provider id: `clinepass`. Short code: `cp`.

## Tests

```bash
cd ma-llm-clinepass-plugin && bun test && bun run typecheck
```
