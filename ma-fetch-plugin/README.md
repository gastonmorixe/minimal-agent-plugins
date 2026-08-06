# ma-fetch-plugin

A [minimal-agent][ma] plugin that provides a `Fetch` tool - fetches web pages
through a real JS-rendering headless browser and returns the content in your
chosen format (markdown / text / html / links / accessibility / raw).

[ma]: https://github.com/gastonmorixe/minimal-agent-core

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
The backend script (today `backends/obscura.ts`) is the _only_ place
that knows about a specific browser's CLI. Tomorrow's
`backends/playwright.ts` honors the same env contract and the handler
stays unchanged.

**Always-on backend invariants** (NOT exposed as tool API):

- Anti-detection / stealth (always on - hygiene)
- Suppress backend banner (always on - clean stdout)

**Tool API** (what the model controls):

- `url` (required)
- `format` (markdown | text | html | links | accessibility | original)
- `selector`, `eval`, `eval_mode`, `wait_until`, `timeout_sec`, `cleanup`
- `session` (persistent cookies + `localStorage`; see _Persistent sessions_ below)

### Backend env-var contract

The handler spawns `<plugin>/backends/<backend>.ts` with these env vars:

| Var                    | Required                | Notes                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MA_FETCH_URL`         | yes                     |                                                                                                                                                                                                                                                                                                                                                                                  |
| `MA_FETCH_FORMAT`      | yes                     | `markdown\|text\|html\|links\|accessibility\|original`                                                                                                                                                                                                                                                                                                                           |
| `MA_FETCH_WAIT_UNTIL`  | yes                     | `load\|domcontentloaded\|networkidle0`                                                                                                                                                                                                                                                                                                                                           |
| `MA_FETCH_TIMEOUT_SEC` | yes                     | integer seconds                                                                                                                                                                                                                                                                                                                                                                  |
| `MA_FETCH_SELECTOR`    | no                      |                                                                                                                                                                                                                                                                                                                                                                                  |
| `MA_FETCH_EVAL`        | no                      | JavaScript expression evaluated in the page context                                                                                                                                                                                                                                                                                                                              |
| `MA_FETCH_EVAL_MODE`   | no                      | `value` returns the expression result; `page` evaluates then returns the requested dump                                                                                                                                                                                                                                                                                          |
| `MA_FETCH_USER_AGENT`  | no                      | from plugin config                                                                                                                                                                                                                                                                                                                                                               |
| `MA_FETCH_PROXY`       | no                      | from plugin config                                                                                                                                                                                                                                                                                                                                                               |
| `MA_FETCH_STORAGE_DIR` | no                      | absolute path resolved from `session` + `storageRoot`; backends that support persistence (obscura) forward as `--storage-dir <DIR>`                                                                                                                                                                                                                                              |
| `MA_FETCH_BIN`         | yes (set by dispatcher) | absolute path to the backend binary. Resolved by `lib/backend.ts:resolveBackendBin`: operator override (`plugins["ma-fetch"].<backend>.bin`) wins, else `<MINIMAL_AGENT_BIN_DIR>/<backend>` (the agent-managed dir, `~/.minimal-agent/bin`). **No PATH fallback**: if it can't be resolved the backend refuses to run (exit 2) and the tool reports an engine-unavailable error. |

Backend output:

- **stdout** → the eval value for `eval_mode: "value"`, otherwise page content; becomes `tool_result.content`
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

3. Get obscura (the default backend). **Normally you do nothing here:** on
   an interactive start the host resolves the rolling `latest` release from
   `gastonmorixe/obscura-dist` (no hardcoded build epoch in the plugin),
   provisions it into the agent-managed dir (`~/.minimal-agent/bin`)
   automatically (see `setup.ts` plus minimal-agent's `binaries/` subsystem),
   and advertises that dir to the plugin via `MINIMAL_AGENT_BIN_DIR`. The
   plugin runs ONLY that managed copy. A newer `latest` on the next boot is
   treated as an update.

   The plugin does **not** look on your `PATH`. A `obscura` you drop into
   `/usr/local/bin` is ignored on purpose (silently running a user's binary is
   a supply-chain hazard). If you want to point at your own build, set an
   absolute path via the `obscura.bin` operator override in config (see
   below). That wins over the managed copy.

4. (Optional) Configure in `~/.minimal-agent/config.jsonc`:

   ```jsonc
   {
     "plugins": {
       "ma-fetch": {
         "enabled": true,
         "backend": "obscura",
         "storageRoot": "~/.minimal-agent/sessions/fetch", // optional override
         "obscura": {
           "bin": "/path/to/obscura",
         },
         "defaults": {
           "format": "markdown",
           "waitUntil": "domcontentloaded",
           "timeoutSec": 30,
           "session": null, // optional: name used when the model omits `session`
         },
       },
     },
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

Session names match `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`. Anything with
`/`, `\`, `..`, dots, or spaces is rejected by the input validator
before it reaches the backend.

**Backend support.** The Rust-side persistence lives in
[obscura's `--storage-dir`](https://github.com/h4ckf0r0day/obscura)
(requires obscura ≥ v0.1.6). Backends that don't recognise
`MA_FETCH_STORAGE_DIR` ignore it; the plugin doesn't fail.

### Persistent worker

Rendered Obscura calls lazily start one parent-bound `obscura-worker` process
and reuse it for later calls. The model still sees only the generic `Fetch`
tool; the engine name and private protocol are not part of the tool contract.
Calls are serialized because Obscura keeps one live V8 isolate at a time.
Named sessions remain resident in a bounded LRU pool and flush cookies plus
`localStorage` after every request and during close, eviction, idle exit, or
graceful shutdown.

The one-shot backend remains the compatibility path for `original`, non-Obscura
backends, disabled persistence, and `eval_mode: "value"`. The worker loads the
first configured WebExtension, matching the one-shot CLI's current behavior.
Worker startup or protocol skew falls back only before a fetch is
dispatched; a dispatched request is never replayed automatically.

The transcript footer may show `worker pid: N` for operator visibility. Model
content remains backend-agnostic. The process exits after its idle timeout and
is also killed as a process group on caller abort, outer watchdog, or parent
exit.

**Config knobs**:

- `obscura.persistent` (`boolean`, default `true`). Set `false` to force the
  existing one-shot backend.
- `obscura.workerIdleSec` (`number`, default `300`, range `10..3600`). Idle
  worker shutdown delay.
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

## Failure traces (operator)

The Fetch tool is backend-agnostic on every surface the model sees: a
failed fetch returns either a typed, engine-free message (timeout, DNS,
TLS, HTTP status, connection error) or, for anything unrecognized, a
generic message with an opaque ref id like `[ref: t-lqy3p-9f1a2b]`.

The full raw detail for an unclassified failure (URL, exit code, backend
that ran, and the backend's **raw stderr**) is written to an
operator-only trace file:

```
$TMPDIR/ma-fetch-traces/<ref-id>.log        # mode 0600
```

(`$TMPDIR` is the OS temp dir, e.g. `/var/folders/.../T/` on macOS,
`/tmp` on Linux.) To debug a failure the model reported, grep that
directory for the ref id.

This path is **deliberately never put in any tool output**: a model told
about a readable file will try to read it. The model only ever gets the
opaque id; the mapping from id to path lives here, in operator docs.
Traces are best-effort (a logging failure never masks the original
fetch error) and are not auto-pruned, so wipe `ma-fetch-traces/`
whenever you like.

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
MA_FETCH_BIN="/path/to/obscura" \
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
MA_FETCH_BIN="/path/to/obscura" \
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
