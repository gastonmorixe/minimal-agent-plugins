# AgentService/Run — grok-4.6, `not_found`, and “Too many computers” (2026-08-17)

How this plugin spent a day chasing the wrong wire id, then found that Cursor
Agent CLI never sends the IDE checksum headers MA copied from a workbench
spike — and that those extra headers were the live `resource_exhausted` /
“Too many computers” failure.

Read this before changing `headers.ts`, `request-body.ts`, `encode-spec.ts`,
`models.ts`, or `client-version.ts`. The code comments in those files are
short; this is the audit trail.

## What this is for

`ma-llm-cursor-plugin` speaks Cursor `agent.v1.AgentService/Run`
(Connect + protobuf) so `ma --provider cursor` can chat with Cursor-hosted
models (`grok-4.6`, Composer, Auto, …). Auth is MA’s store
(`cursor-oauth-2` / `cursor-oauth` / API key), not Cursor IDE keychain.

On 2026-08-17 the live path was broken in two different ways that **looked
like one model-id bug**. Official Cursor Agent CLI (`cursor-agent`) and the
user’s Grok CLI (`agent` in fish) both worked. MA did not.

This document is for the next agent: what we observed, which hypotheses were
wrong, what we reverse-engineered, and which fix actually made
`--prompt "hello"` return text.

## Symptoms (what the user pasted)

Three distinct failures, in order:

### 1. Unknown host model id

```text
ma --provider cursor --model grok-4.6 --credential-name "cursor-oauth-2"
fatal: unknown model "grok-4.6" for provider "cursor"
```

`--provider cursor` looks up **that exact id** in the Cursor-scoped registry
(`findModelForProvider`). It does not strip `cursor-` and it does not fall
through to Grok’s `grok-4.6`. The catalog only registered the namespaced
parent `cursor-grok-4.6`.

`--model cursor-grok-4.6` booted the TUI.

### 2. Connect `not_found` with a useless message

```text
ma --provider cursor --model cursor-grok-4.6 --no-tools --prompt "hello"
fatal: cursor connect end-stream: not_found: Error
```

Interactive “hi” on the same model printed the same trailer. The host only
showed Connect `error.message`, which Cursor often sets to the literal
string `"Error"`. The useful title lived in `error.details`.

### 3. Connect `resource_exhausted` (same generic `"Error"`)

Earlier in the day, exploded SKUs such as `cursor-grok-4.6-high` returned:

```text
cursor connect end-stream: resource_exhausted: Error
```

After trailer parsing was fixed this became:

```text
cursor connect end-stream: resource_exhausted: ERROR_CUSTOM_MESSAGE: Too many computers.
```

That title is what sent us down a “device quota / extra sessions” story.
The user correctly pushed back: they could open the working harness as many
times as they wanted.

## Root cause (the thing that was actually wrong)

**MA’s `buildCursorHeaders` sent IDE workbench fingerprint headers on every
AiService / AgentService call. Cursor Agent CLI’s AgentService interceptor
does not.**

Workbench spike headers MA was sending (and CLI was not):

| Header | MA (before fix) | Cursor Agent CLI AgentService interceptor |
| ------ | --------------- | ----------------------------------------- |
| `authorization` | Bearer from MA auth store | Bearer from CLI credential manager |
| `x-ghost-mode` | `"true"` by default | from `privacyCache.ghostMode` (true here) |
| `x-cursor-client-version` | `cli-YYYY.MM.DD-<sha>` | `cli-2026.08.11-e8db854` |
| `x-cursor-client-type` | `"cli"` | telemetry `surface: "cli"` |
| `x-request-id` | UUID | UUID |
| `x-cursor-checksum` | **yes** (IDE scramble + telemetry machine ids) | **no** |
| `x-client-key` | **yes** (sha256 of machineId) | **no** |
| `x-session-id` | **yes** (fresh UUID per `loadClientIds()`) | **no** |
| `x-cursor-client-arch` / `-os` / `-device-type` | **yes** | **no** |
| `x-cursor-timezone` | **yes** | **no** |
| `x-cursor-streaming` | **yes** | **no** |
| `x-amzn-trace-id` | **yes** | **no** |

CLI still sends Connect content-type / protocol headers via `@connectrpc/connect-node`.
The interceptor in `~/.local/share/cursor-agent/versions/2026.08.11-e8db854/index.js`
only adds auth, ghost-mode, client-type, client-version, request-id, and
optionally `x-dev-experiment-overrides`. The call `(0,A._5)(i.header)` is
**not** checksum: `A` is `cursor-config`, and `_5` only sets
`local-cli-mode: true` when `CURSOR_AGENT_CLI_LOCAL_MODE=true`.

Those extra IDE headers made AgentService treat MA as **another computer**
on the same account. Official `cursor-agent` can be opened repeatedly
because those sessions share the CLI identity and do not present a second
checksum. MA looked like a new device (and a new one on every process if
`sessionId` was minted per `loadClientIds()`).

**Fix:** `buildCursorHeaders` defaults to `fingerprint: "cli"` and omits the
IDE set. `fingerprint: "ide"` remains for reproducing the spike / debugging.

**Proof (2026-08-17 ~23:21 local):** same machine, same account, back to back:

```text
/Users/gaston/.local/bin/cursor-agent -p --trust --output-format text --model grok-4.6 "Reply with exactly: PONG"
→ PONG

ma --provider cursor --model grok-4.6 --credential-name "cursor-oauth-2" --no-tools --prompt "Reply with exactly: PONG"
→ PONG   (after dropping IDE fingerprint; hung after the reply — TUI/process
         teardown, not the model call)
```

Immediately **before** that header change, the identical MA command still
returned `Too many computers` while `cursor-agent -p` returned `PONG`. So
this was not account-wide quota cooldown.

## What we got wrong (do not repeat these)

Ordered by how expensive they were.

### Wrong 1 — “Too many computers means you opened too many CLIs”

Official Cursor Agent CLI and the user’s Grok CLI both worked with many
concurrent sessions. MA failed **in the same second** as a successful
`cursor-agent -p`. Session count was not the differentiator. The
differentiator was **which headers** identified the client.

### Wrong 2 — “AgentService/Run rejects parent `grok-4.6` + parameters”

Cursor Agent CLI **does** send parameterized parents. Confirmed in CLI
bundle `3363.index.js` (`./src/bedrock/requested-model.ts` is Bedrock-only;
the main path is `new RequestedModel({ modelId: e.model.name, parameters: … })`
with `e.model.name === "grok-4.6"` and config `modelParameters.grok-4.6 =
[{effort: high}, {fast: true}]`). `~/.cursor/cli-config.json`
`selectedModel` matches that picker shape.

An **afternoon** live capture (~12:07 local, host `https://agentn.api5.cursor.sh`,
client version `3.12.30`) also succeeded with exploded SKU
`cursor-grok-4.6-high` and `built_in_model=true`. So **both shapes have
been accepted** depending on the rest of the request.

What MA saw tonight:

| MA RequestedModel | With IDE fingerprint | After CLI headers |
| ----------------- | -------------------- | ----------------- |
| parent `grok-4.6` + `effort`/`fast` | Connect `not_found` / `ERROR_BAD_MODEL_NAME` (“AI Model Not Found”) | **not re-A/B’d** after the header fix |
| exploded SKU `cursor-grok-4.6-high` | `resource_exhausted` / “Too many computers” | **PONG** |

We treated the `not_found` as “parent+params is an invalid Run id” and
rewrote encode to always explode SKUs. That was a **correlated** failure
(bad headers + that body), not a proof that CLI’s encode is illegal.
The SKU remap is still in the tree and **did** work once headers matched
CLI. Do not rip it out without a new A/B; do not claim CLI is wrong either.

### Wrong 3 — “`--model grok-4.6` should just work because the API name is grok-4.6”

Host ids are provider-namespaced on purpose. Grok registers `id: grok-4.6`.
If Cursor registered that as a **global alias**, boot throws
`alias "…" collides with an existing model id`. Dual-registering the same
string as a **second provider-scoped id** is allowed (`modelsByProvider`).
`--provider cursor --model grok-4.6` needs that Cursor-scoped row. Without
`--provider cursor`, `grok-4.6` is Grok’s model, not Cursor’s.

### Wrong 4 — “The working `agent` in tmux is Cursor Agent CLI”

On this machine:

| Shell | `which agent` | What it is |
| ----- | ------------- | ---------- |
| **fish** (user tmux) | `~/.grok/bin/agent` | xAI Grok shell. Debug log: `xai_grok_shell`, `base_url: https://cli-chat-proxy.grok.com/v1`, `X-XAI-Token-Auth: xai-grok-cli`. Completely different backend. |
| **zsh** (many agent sessions) | `~/.local/bin/agent` → `…/cursor-agent/versions/2026.08.11-e8db854/cursor-agent` | Official Cursor Agent CLI. Speaks AgentService/Run. |

The tmux pane that printed `Hello. How can I help you today?` for
`agent --debug --debug-file /tmp/agent-debug-file-001.log -p "hello"` was
**Grok**, not Cursor. Help text (`~/.grok`, `login` → Grok, models
`grok-4.6` / `grok-4.5` only) is the tell. Never treat `agent` as Cursor
without `which agent` / `--help` first line (`Start the Cursor Agent` vs
Grok shell).

The real Cursor A/B is:

```bash
~/.local/bin/cursor-agent -p --trust --output-format text --model grok-4.6 "…"
# vs
ma --provider cursor --model grok-4.6 --credential-name cursor-oauth-2 --no-tools --prompt "…"
```

### Wrong 5 — “Generic Connect `Error` is the whole story”

`parseConnectEndStreamError` used to format `code` + `message` only.
Cursor often sends `message: "Error"` and puts `ERROR_BAD_MODEL_NAME` /
`ERROR_CUSTOM_MESSAGE` + `details.title` (`AI Model Not Found`,
`Too many computers`) in `error.details`. Without walking `details`,
`not_found` and `resource_exhausted` look like empty failures and you
will “fix” the wrong layer (model id vs identity).

### Wrong 6 — “Match the IDE spike client version / checksum and we are CLI-compatible”

The 2026-07 workbench spike (`3.12.30`, checksum, `x-client-key`) was a
valid **IDE** client. AgentService for the **CLI** product is picky about
looking like that IDE. Comments in `wire-constants.ts` / `client-version.ts`
already warned that `3.12.30` can surface as `resource_exhausted`; we
still kept the rest of the IDE fingerprint. Matching `cli-*` version while
keeping checksum was not enough.

### Wrong 7 — Probing AgentService/Run ten ways in one night

Each MA process with a checksum + fresh `x-session-id` looked like more
computers. That made `Too many computers` stickier and poisoned the A/B
(“SKU is invalid” vs “identity quota”). After you have **one** red command
and **one** green official CLI command, change **one** variable.

## How we finally found it

Tight loop that actually distinguished the bug (after the user pushed back):

1. Confirm tmux: fish `agent` is Grok. Not the comparison we wanted.
2. Run **official** `cursor-agent -p --model grok-4.6` → `PONG` (works).
3. Run **MA** with the same prompt immediately after → `Too many computers`
   (still red). So not “wait for quota” and not “SKU is illegal on this
   account”.
4. Reverse-engineer CLI header interceptor in
   `~/.local/share/cursor-agent/versions/2026.08.11-e8db854/index.js`:
   search `x-cursor-client-type`, then `(0,A._5)(i.header)`, then resolve
   `A` → `../cursor-config/dist/index.js`. `_5` is `function a(e){ s() && e.set("local-cli-mode","true") }`.
   Grep of that CLI tree: **zero** `x-client-key` / `x-cursor-checksum` /
   `x-session-id` on the AgentService path (checksum appears only on
   worker-bridge registration in `5326.index.js`, gated on
   `cursorChecksumHeader`).
5. Drop IDE fingerprint in `headers.ts`. Same MA command → `PONG`.

That is the whole finding. Model-id work was not wasted for the catalog /
`--model grok-4.6` resolution, but it was not why CLI worked and MA did not
once the TUI had already accepted `cursor-grok-4.6`.

## Reverse engineering notes (keep these paths)

CLI install used on 2026-08-17:

```text
~/.local/bin/cursor-agent
  → ~/.local/share/cursor-agent/versions/2026.08.11-e8db854/cursor-agent
```

| Question | Where we looked | Result |
| -------- | --------------- | ------ |
| Picker vs Run model id | `~/.cursor/cli-config.json` `selectedModel.modelId` + `modelParameters.grok-4.6` | Picker is parent `grok-4.6` + `{effort: high, fast: true}` |
| Does Run send that picker shape? | `3363.index.js` `new o.RequestedModel({modelId:e.model.name, parameters:…})` | Yes, parent name + parameter values. `builtInModel` omitted (proto3 false). `isVariantStringRepresentation` omitted on that path. |
| Agent URL | `cli-config.json` `serverConfigCache.agentUrlConfig` | `https://agentn.global.api5.cursor.sh` (same as plugin default after GetServerConfig overlay) |
| HTTP/1 vs h2 | interceptor `X(…)` uses `httpVersion:"1.1"` for some clients; `useHttp1ForAgent` in config is `false`; server can force bidi/h2 | MA streams with host `NetworkClient` `protocol: "h2"`. Not the smoking gun; headers were. |
| Checksum algorithm | plugin `checksum.ts` (IDE `workbench.desktop.main.js` reconstruction) | Still correct **for the IDE**. CLI AgentService does not send it. |
| Machine ids MA used | Cursor IDE `storage.json` `telemetry.machineId` / `telemetry.macMachineId` via `ids.ts` | Fine for IDE. Irrelevant once we stop sending checksum. |
| AvailableModels | plugin already used `use_model_parameters=true`, `do_not_use_markdown=true`, `clientType: "cli"` | Catalog is parameterized parents + `legacy_slug` variants. Keep that. |
| Connect trailer | JSON `{ error: { code, message, details: [{ debug: { error, details: { title } } }] } }` | Parse `details` or you will debug the word `"Error"`. |

Do **not** paste JWTs, `auth.jsonc` secrets, or `--api-key` process argv into
docs or chat. The Cursor IDE worker command line on this machine included a
live `crsr_…` key in `ps`; ignore it, do not copy it.

## Catalog vs Run encode (what the code does now)

Parameterized **AvailableModels** (`use_model_parameters=true`) is the right
**catalog**. Parents are API names (`grok-4.6`). Variants have `legacy_slug`
(e.g. `cursor-grok-4.6-high`) plus `parameterValues`.

**Host registry**

- Namespaced ids: `cursor-grok-4.6`, `cursor-grok-4.6-high`, `cursor-auto`, …
- Dual-register parent API names as Cursor-scoped ids (`grok-4.6`,
  `composer-2.5`, …) except `default` / `auto`, skipping rows tagged `alias`.
  Collision with another provider’s **alias** is caught; same id on two
  providers is OK.
- Live `listCursorLiveModels` rows stay `cursor-*` (e2e asserts that). Dual
  ids exist in the registry for `--model grok-4.6 --provider cursor`.

**Run `RequestedModel.model_id` (current encoder)**

Prefer exploded SKU, omit `parameters` and f8:

1. Encode spec `useVariantString` → variant string + f8.
2. Encode spec `runModelId` (variant row) → that SKU, no params.
3. Grok exploded host id (`cursor-grok-4.6-high`) → that id.
4. Parent + `req.effort` / `req.speed` (or capability default, often
   `medium`) → SKU index (`grok-4.6|effort=medium`) or constructed
   `cursor-grok-4.6-medium`.
5. Fallback: parent API name + `RequestedModel.parameters` (composer-style
   tests without a SKU).

TUI default effort **medium** means parent `cursor-grok-4.6` encodes
`cursor-grok-4.6-medium`, not CLI’s configured high+fast SKU
`cursor-grok-4.6-high-fast`. That is intentional MA default, not a CLI clone.

`vendorIds.cursor` is the Run id for variants (SKU) and the API name for
parents.

If someone later proves parent+params works on MA **with CLI headers**, it
is reasonable to send CLI’s shape for parents and keep SKUs for exploded
host ids. Do not silently revert headers to IDE fingerprint to “make SKUs
work”.

## Connect error parsing

`proto/agent-run.ts` `parseConnectEndStreamError` walks `error.details` for
`title`, `detail`, `error` (`ERROR_*`), `reason`. Generic `"Error"` is
dropped when a title exists. Tests: `response-stream.test.ts` (“surfaces
Connect details title when message is generic Error”).

`resource_exhausted` still maps to canonical `rate_limit`. The printed
`cause.message` must include `Too many computers` so the next debugger
does not think it is a generic 429.

## Current header contract

`headers.ts` `fingerprint` (default `"cli"`):

- **cli:** `authorization`, `content-type` / `accept`, `connect-protocol-version`,
  `connect-accept-encoding` (streams), `user-agent`, `x-cursor-client-type`,
  `x-cursor-client-version`, `x-ghost-mode`, `x-request-id`.
- **ide:** also checksum, client-key, session-id, arch/os/device, timezone,
  streaming flag, `x-amzn-trace-id`.

`ids.ts` / `checksum.ts` stay in tree for `fingerprint: "ide"` and unit
tests. They are not what AgentService/Run wants for the CLI product.

Client version still prefers installed `cli-YYYY.MM.DD-<sha>`
(`client-version.ts`). Keep matching the installed Cursor Agent CLI stamp.

## How to re-verify (one shot, not a probe grid)

Need `cursor-oauth-2` in `~/.minimal-agent/auth.jsonc`. Do not dump tokens.

```bash
# Official Cursor Agent CLI (not fish `agent` unless which says cursor-agent)
~/.local/bin/cursor-agent -p --trust --output-format text --model grok-4.6 \
  "Reply with exactly: PONG"

# MA — namespaced parent, exploded SKU, and dual-registered API id
cd minimal-agent-core
bun run src/index.ts --provider cursor --model cursor-grok-4.6-high \
  --credential-name "cursor-oauth-2" --no-tools --prompt "Reply with exactly: PONG"
bun run src/index.ts --provider cursor --model grok-4.6 \
  --credential-name "cursor-oauth-2" --no-tools --prompt "Reply with exactly: PONG"
```

Green: stdout contains `PONG` (MA may linger in the TUI after `--prompt`;
that is a host teardown issue, not Run). Red: print the **full**
`cause.message` including Connect `details.title`.

Unit: `cd ma-llm-cursor-plugin && bun test` (header tests assert checksum
absent by default; grok SKU encode tests; `grok-4.6` dual-register).

Live E2E: `E2E=1 bun test cursor.e2e.test.ts` (needs auth; may still skip).

## What not to do next time

- Do not assume `agent` on PATH is Cursor. `which -a agent` first.
- Do not compare MA to Grok CLI when the bug is AgentService/Run.
- Do not treat Connect `message: "Error"` as the diagnostic. Parse `details`.
- Do not add IDE checksum/client-key/session headers “for completeness”.
- Do not fire a 10-way encode matrix against live Run; it looks like more
  computers and muddies the loop.
- Do not register bare Cursor wire ids as **aliases** (Grok collision). Dual
  **ids** per provider are the supported escape hatch.
- Do not copy this postmortem’s old “parent+params is illegal” claim into
  new code comments. The CLI still sends it. MA’s SKU path is the current
  encoder, proven after the header fix, not a law of the API.

## File map

| File | Role in this incident |
| ---- | --------------------- |
| `headers.ts` | CLI vs IDE fingerprint. Default is CLI. |
| `checksum.ts` / `ids.ts` | IDE fingerprint only. |
| `client-version.ts` / `wire-constants.ts` | `cli-*` stamp; do not go back to `3.12.30` as default. |
| `request-body.ts` | SKU-first Run encode; parent+params fallback. |
| `encode-spec.ts` | Per-id `runModelId` + parent SKU index. |
| `catalog-expand.ts` | Parents + `legacy_slug` variants; `runModelId` = slug as-is. |
| `models.ts` | Static seed, dual API ids, `resolveCursorWireId` keeps Grok SKUs. |
| `proto/agent-run.ts` | Connect trailer + `details` titles. |
| `response-stream.ts` | Surfaces `cause.message` to the host. |
| `cursor.test.ts` / `auth.test.ts` / `response-stream.test.ts` | Header + encode + trailer regressions. |
| `scripts/probe-run-encode.ts` | Live A/B helper. Easy to overuse; prefer the two-command loop above. |
