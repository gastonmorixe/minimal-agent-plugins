# ma-fetch-plugin

A [minimal-agent][ma] plugin that provides a `Fetch` tool - fetches web pages
through a real JS-rendering headless browser and returns the content in your
chosen format (markdown / text / html / links / raw).

[ma]: https://github.com/gastonmorixe/minimal-agent

## Architecture

```
ma-fetch-plugin/
├── manifest.json           Plugin manifest (tool name, schema, icon)
├── PROMPT.md               When/how the model should use this tool
├── handlers/
│   ├── fetch.ts            Backend-agnostic handler: validate → dispatch → ToolResult
│   └── fetch.test.ts
├── lib/
│   ├── types.ts            Local TUIContext/TUIResult stubs (standalone type-check)
│   ├── jsonc.ts            Tiny JSONC parser (zero-dep config reader)
│   ├── config.ts           Reads plugins["ma-fetch"] from ~/.minimal-agent/config.jsonc
│   ├── config.test.ts
│   ├── backend.ts          Backend dispatcher: builds env, spawns script, captures I/O
│   └── backend.test.ts
└── backends/
    ├── obscura.ts          Default backend (wraps obscura CLI)
    └── obscura.test.ts
```

### Backend decoupling

The handler doesn't know obscura exists. It builds a `BackendCallInput`
from validated tool input + config defaults, then asks `lib/backend.ts`
to invoke the configured backend script with an `MA_FETCH_*` env block.
The backend script (today `backends/obscura.ts`) is the *only* place
that knows about a specific browser's CLI. Tomorrow's
`backends/playwright.ts` honors the same env contract and the handler
stays unchanged.

**Always-on backend invariants** (NOT exposed as tool API):
- Anti-detection / stealth (always on - hygiene)
- Suppress backend banner (always on - clean stdout)

**Tool API** (what the model controls):
- `url` (required)
- `format` (markdown | text | html | links | original)
- `selector`, `eval`, `wait_until`, `timeout_sec`, `cleanup`
- `session` (persistent cookies + `localStorage`; see *Persistent sessions* below)

### Backend env-var contract

The handler spawns `<plugin>/backends/<backend>.ts` with these env vars:

| Var | Required | Notes |
|---|---|---|
| `MA_FETCH_URL` | yes | |
| `MA_FETCH_FORMAT` | yes | `markdown\|text\|html\|links\|original` |
| `MA_FETCH_WAIT_UNTIL` | yes | `load\|domcontentloaded\|networkidle0` |
| `MA_FETCH_TIMEOUT_SEC` | yes | integer seconds |
| `MA_FETCH_SELECTOR` | no | |
| `MA_FETCH_EVAL` | no | |
| `MA_FETCH_USER_AGENT` | no | from plugin config |
| `MA_FETCH_PROXY` | no | from plugin config |
| `MA_FETCH_STORAGE_DIR` | no | absolute path resolved from `session` + `storageRoot`; backends that support persistence (obscura) forward as `--storage-dir <DIR>` |
| `MA_FETCH_BIN` | no | from `plugins["ma-fetch"].<backend>.bin` |

Backend output:
- **stdout** → page content (verbatim, becomes `tool_result.content`)
- **stderr** → diagnostics (shown to the user on errors)
- **exit code** → 0 on success, non-zero on failure

## Install

1. Clone this repo (you probably already did):

   ```bash
   git clone git@github.com:gastonmorixe/minimal-agent-plugins.git ~/minimal-agent-plugins
   ```

2. Symlink the plugin into your minimal-agent home plugin root:

   ```bash
   mkdir -p ~/.agents/plugins
   ln -s ~/minimal-agent-plugins/ma-fetch-plugin ~/.agents/plugins/ma-fetch-plugin
   ```

3. Install [obscura][o] (the default backend). Easiest:

   ```bash
   # macOS Apple Silicon
   curl -LO https://github.com/h4ckf0r0day/obscura/releases/latest/download/obscura-aarch64-macos.tar.gz
   tar xzf obscura-aarch64-macos.tar.gz
   sudo mv obscura /usr/local/bin/
   ```

   If you put obscura somewhere off `PATH`, set its location in config
   (see below).

4. (Optional) Configure in `~/.minimal-agent/config.jsonc`:

   ```jsonc
   {
     "plugins": {
       "ma-fetch": {
         "enabled": true,
         "backend": "obscura",
         "storageRoot": "~/.minimal-agent/sessions/fetch",  // optional override
         "obscura": {
           "bin": "/Users/me/Projects/obscura/target/release/obscura"
         },
         "defaults": {
           "format": "markdown",
           "waitUntil": "domcontentloaded",
           "timeoutSec": 30,
           "session": null  // optional: name used when the model omits `session`
         }
       }
     }
   }
   ```

5. Start `minimal-agent`. The startup banner should list `Fetch` in the
   tools row.

[o]: https://github.com/h4ckf0r0day/obscura

## Persistent sessions

`Fetch` is stateless by default — every call gets a fresh cookie jar
and an empty `localStorage`. Pass `session: "<name>"` (the model) to
keep both alive across calls, and the second call comes back logged in.

The plugin sandboxes session names under a single root directory so
the model can never reach outside it:

```
~/.minimal-agent/sessions/fetch/        ← storageRoot (configurable)
  twitter/
    cookies.json
    localstorage.json
  linkedin/
    cookies.json
    localstorage.json
  ...
```

Session names match `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}# ma-fetch-plugin

A [minimal-agent][ma] plugin that provides a `Fetch` tool - fetches web pages
through a real JS-rendering headless browser and returns the content in your
chosen format (markdown / text / html / links / raw).

[ma]: https://github.com/gastonmorixe/minimal-agent

## Architecture

```
ma-fetch-plugin/
├── manifest.json           Plugin manifest (tool name, schema, icon)
├── PROMPT.md               When/how the model should use this tool
├── handlers/
│   ├── fetch.ts            Backend-agnostic handler: validate → dispatch → ToolResult
│   └── fetch.test.ts
├── lib/
│   ├── types.ts            Local TUIContext/TUIResult stubs (standalone type-check)
│   ├── jsonc.ts            Tiny JSONC parser (zero-dep config reader)
│   ├── config.ts           Reads plugins["ma-fetch"] from ~/.minimal-agent/config.jsonc
│   ├── config.test.ts
│   ├── backend.ts          Backend dispatcher: builds env, spawns script, captures I/O
│   └── backend.test.ts
└── backends/
    ├── obscura.ts          Default backend (wraps obscura CLI)
    └── obscura.test.ts
```

### Backend decoupling

The handler doesn't know obscura exists. It builds a `BackendCallInput`
from validated tool input + config defaults, then asks `lib/backend.ts`
to invoke the configured backend script with an `MA_FETCH_*` env block.
The backend script (today `backends/obscura.ts`) is the *only* place
that knows about a specific browser's CLI. Tomorrow's
`backends/playwright.ts` honors the same env contract and the handler
stays unchanged.

**Always-on backend invariants** (NOT exposed as tool API):
- Anti-detection / stealth (always on - hygiene)
- Suppress backend banner (always on - clean stdout)

**Tool API** (what the model controls):
- `url` (required)
- `format` (markdown | text | html | links | original)
- `selector`, `eval`, `wait_until`, `timeout_sec`, `cleanup`
- `session` (persistent cookies + `localStorage`; see *Persistent sessions* below)

### Backend env-var contract

The handler spawns `<plugin>/backends/<backend>.ts` with these env vars:

| Var | Required | Notes |
|---|---|---|
| `MA_FETCH_URL` | yes | |
| `MA_FETCH_FORMAT` | yes | `markdown\|text\|html\|links\|original` |
| `MA_FETCH_WAIT_UNTIL` | yes | `load\|domcontentloaded\|networkidle0` |
| `MA_FETCH_TIMEOUT_SEC` | yes | integer seconds |
| `MA_FETCH_SELECTOR` | no | |
| `MA_FETCH_EVAL` | no | |
| `MA_FETCH_USER_AGENT` | no | from plugin config |
| `MA_FETCH_PROXY` | no | from plugin config |
| `MA_FETCH_STORAGE_DIR` | no | absolute path resolved from `session` + `storageRoot`; backends that support persistence (obscura) forward as `--storage-dir <DIR>` |
| `MA_FETCH_BIN` | no | from `plugins["ma-fetch"].<backend>.bin` |

Backend output:
- **stdout** → page content (verbatim, becomes `tool_result.content`)
- **stderr** → diagnostics (shown to the user on errors)
- **exit code** → 0 on success, non-zero on failure

## Install

1. Clone this repo (you probably already did):

   ```bash
   git clone git@github.com:gastonmorixe/minimal-agent-plugins.git ~/minimal-agent-plugins
   ```

2. Symlink the plugin into your minimal-agent home plugin root:

   ```bash
   mkdir -p ~/.agents/plugins
   ln -s ~/minimal-agent-plugins/ma-fetch-plugin ~/.agents/plugins/ma-fetch-plugin
   ```

3. Install [obscura][o] (the default backend). Easiest:

   ```bash
   # macOS Apple Silicon
   curl -LO https://github.com/h4ckf0r0day/obscura/releases/latest/download/obscura-aarch64-macos.tar.gz
   tar xzf obscura-aarch64-macos.tar.gz
   sudo mv obscura /usr/local/bin/
   ```

   If you put obscura somewhere off `PATH`, set its location in config
   (see below).

. Anything with
`/`, `\`, `..`, dots, or spaces is rejected by the input validator
before it reaches the backend.

**Backend support.** The Rust-side persistence lives in
[obscura's `--storage-dir`](https://github.com/h4ckf0r0day/obscura)
(requires obscura ≥ v0.1.6). Backends that don't recognise
`MA_FETCH_STORAGE_DIR` ignore it; the plugin doesn't fail.

**Config knobs**:

- `storageRoot` (`string`, default `~/.minimal-agent/sessions/fetch`).
  Where session subdirectories live. Tilde is expanded. Absolute paths
  only — relative paths are silently rejected.
- `defaults.session` (`string | null`, default `null`). Applied when
  the model omits `session`. Same regex as the per-call field. The
  model can opt out for one call by passing `session: ""`.

**Threat model**:

- Cookies and `localStorage` land in plaintext JSON. Sites stash auth
  tokens in both. The directory inherits your `umask` — treat it the
  way you'd treat a Chrome profile dir.
- No cross-process / cross-instance locking. Two `Fetch` calls
  targeting the same session at the same time will race. Calls are
  sequential per agent turn, so this rarely matters.
- The model picks the session name. If you don't want the model
  inventing names like `my-twitter-account`, set
  `defaults.session` to a fixed value and tell users to pass
  `session: ""` to opt out.

## Tests

```bash
# All tests
bun test

# Single file
bun test handlers/fetch.test.ts
```

Tests are colocated with the code they exercise (`foo.ts` ↔ `foo.test.ts`).
The handler tests inject a fake `spawnFn` so the real obscura binary is
never invoked - fast and offline.

## Smoke test the backend in isolation

```bash
MA_FETCH_URL="https://example.com" \
MA_FETCH_FORMAT="markdown" \
MA_FETCH_WAIT_UNTIL="domcontentloaded" \
MA_FETCH_TIMEOUT_SEC="30" \
MA_FETCH_BIN="/Users/me/Projects/obscura/target/release/obscura" \
bun backends/obscura.ts
```

Should print the rendered markdown to stdout, exit 0.

With persistence:

```bash
MA_FETCH_URL="https://example.com" \
MA_FETCH_FORMAT="markdown" \
MA_FETCH_WAIT_UNTIL="domcontentloaded" \
MA_FETCH_TIMEOUT_SEC="30" \
MA_FETCH_STORAGE_DIR="$HOME/.minimal-agent/sessions/fetch/smoke" \
MA_FETCH_BIN="/Users/me/Projects/obscura/target/release/obscura" \
bun backends/obscura.ts
```

After the first call, `~/.minimal-agent/sessions/fetch/smoke/` should
contain `cookies.json` and `localstorage.json`.

## Adding a new backend

1. Drop `backends/<name>.ts` (executable, `#!/usr/bin/env bun`).
2. Have it read the `MA_FETCH_*` env vars and write page content to
   stdout, diagnostics to stderr, exit 0 on success.
3. Set `plugins["ma-fetch"].backend = "<name>"` in user config.

No handler edits, no manifest edits.
