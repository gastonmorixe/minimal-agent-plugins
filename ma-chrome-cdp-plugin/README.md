# ma-chrome-cdp-plugin

A minimal-agent plugin that exposes a **`ChromeCDP`** tool: drive an
already-running Chrome/Chromium over the Chrome DevTools Protocol, through a
**persistent daemon + unix socket** so macOS prompts for Local Network access
only once.

## The problem this solves

Controlling Chrome via CDP means connecting to its debug port
(`--remote-debugging-port=9222`). Two things make the naive approach painful on
macOS:

1. **Local Network privacy.** Every _new process_ that opens a TCP socket to
   that port triggers an "allow" prompt. A short-lived client per command = a
   prompt per command.
2. **DNS-rebind protection.** Newer Chrome/Chromium return `404` for the `/json`
   discovery endpoints, so the usual "GET /json/version to find the websocket"
   trick fails.

This plugin fixes both:

- A long-lived **daemon** (`bin/cdp-server.ts`) connects to Chrome's
  browser-level websocket **once** (one allow prompt, ever) and stays connected.
- It reads the websocket URL straight from the profile's **`DevToolsActivePort`**
  file, sidestepping the blocked `/json` endpoints.
- It serves a tiny HTTP API over a **unix domain socket** (`/tmp/cdp.sock`).
  Unix sockets are filesystem objects, not "network", so callers never trip
  Local Network privacy. After the daemon starts, everything is silent.

The `ChromeCDP` tool handler auto-starts the daemon on first use, so the model
just calls the tool.

## Requirements

- Bun (the workspace toolchain).
- Chrome/Chromium/Brave/Edge launched with `--remote-debugging-port=9222`.

## Layout

```
manifest.json            tool registration (ChromeCDP) + input schema + ui.setup
PROMPT.md                model-facing usage guidance
handlers/chrome_cdp.ts   tool handler (thin shell over lib/)
ui/setup.ts              CLI only: installs the terminal kit into the style slots
bin/cdp-server.ts        the persistent daemon
bin/cdpd.ts              daemon control CLI: start|stop|restart|status|logs
lib/
  protocol.ts            pure CDP frame/parse/classify helpers
  profile.ts             DevToolsActivePort discovery
  connection.ts          stateful CDP connection (WebSocket injected for tests)
  dispatch.ts            route -> CDP calls
  routes.ts              route contract + body validation
  input.ts               tool input -> route + body
  evaluate.ts            Runtime.evaluate result/exception shaping
  events.ts              bounded ring buffer for async CDP event pushes
  client.ts              unix-socket client + ensure-daemon lifecycle
  render.ts              daemon response -> tool_result content/display
  style.ts               style slots (plain until ui/setup.ts runs)
  types.ts               local minimal-agent contract stubs
*.test.ts                bun tests next to each module
```

## Daemon lifecycle (manual)

```sh
bun run bin/cdpd.ts start      # one Local Network allow, then silent
bun run bin/cdpd.ts status
bun run bin/cdpd.ts logs
bun run bin/cdpd.ts stop
```

Talk to it directly for debugging:

```sh
curl --unix-socket /tmp/cdp.sock http://x/ping
curl --unix-socket /tmp/cdp.sock http://x/targets
curl --unix-socket /tmp/cdp.sock http://x/eval -d '{"target":"<id>","expr":"document.title"}'
```

## Tool actions

Convenience:
`ping · targets · alltargets · eval · frameeval · nav · newtab · setdownload · downloads · closetarget · activatetarget · getinfo`

Full-protocol:

- `send`: generic passthrough. Forward ANY CDP method (`method` in `Domain.method` form) with arbitrary `params`, optionally scoped to a tab via `target` (or an explicit `sessionId`). This is what unlocks Network, Performance, Tracing, Profiler, HeapProfiler, DOM, Emulation, CSS, Accessibility, Storage, Fetch, Input, Log (the entire protocol) without the daemon hand-coding each domain.
- `events`: drain the async event stream. CDP events (e.g. `Network.responseReceived`) are unsolicited pushes with no reply id. The long-lived daemon buffers them in a bounded ring so a later poll can read them. Filter by `filter`/`sessionId`, page with a `since` cursor, cap with `limit`, drop with `clear`.
- `record`: toggle event buffering (auto-enabled whenever you `send` a `*.enable`).

```sh
# enable network capture on a tab, then drain it
curl --unix-socket /tmp/cdp.sock http://x/send \
  -d '{"method":"Network.enable","target":"<id>"}'
curl --unix-socket /tmp/cdp.sock http://x/events -d '{"filter":"Network"}'
# read perf metrics
curl --unix-socket /tmp/cdp.sock http://x/send -d '{"method":"Performance.enable"}'
curl --unix-socket /tmp/cdp.sock http://x/send -d '{"method":"Performance.getMetrics"}'
```

See PROMPT.md for the model-facing contract and calling tips (clicking custom
widgets, setting React inputs, download verification, iframe/login caveats, the
`send`/`events` network+perf inspection loop).

## Config (env)

| Var                    | Default               | Meaning                                                      |
| ---------------------- | --------------------- | ------------------------------------------------------------ |
| `CDP_PORT`             | `9222`                | Chrome remote-debugging port                                 |
| `CDP_SOCK`             | `/tmp/cdp.sock`       | unix socket the daemon listens on                            |
| `CDP_DTAP`             | auto-detected         | path to `DevToolsActivePort` (override)                      |
| `CDP_LOG`              | `/tmp/cdp-server.log` | daemon log file                                              |
| `CDP_LEASE_DIR`        | `<CDP_SOCK>.leases`   | one file per client pid (lease)                              |
| `CDP_IDLE_MS`          | `600000`              | exit after this idle time with no live lease (`0` = never)   |
| `CDP_LEASE_CHECK_MS`   | `30000`               | interval of the lease sweep and idle check                   |
| `CDP_MAX_RECONNECT`    | `30`                  | exit after this many failed Chrome reconnects (`0` = no cap) |
| `CDP_READY_TIMEOUT_MS` | `15000`               | a request waits this long for the first Chrome connect       |
| `CDP_LEASE_MAX_AGE_MS` | `86400000`            | drop a lease not refreshed for this long (`0` = no limit)    |

### Daemon lifetime

1. One daemon per socket. A new daemon pings the socket under
   `<CDP_SOCK>.bind.lock`. If a live daemon answers, the new one exits 0.
   A stale lock is moved away with an atomic rename, so only one caller
   breaks it.
2. The `ChromeCDP` handler takes `<CDP_SOCK>.spawn.lock` before it spawns,
   so two sessions at once start one daemon. Its ping times out after 2 s.
3. Each client process writes `<lease dir>/<pid>` (`{"pid","time"}`) on each
   call and removes it when the process exits. The daemon removes the leases
   of dead pids and the leases not refreshed for `CDP_LEASE_MAX_AGE_MS`. It
   exits when no live lease is left and no request came for `CDP_IDLE_MS`.
   The idle timer starts when the socket is bound, before the Chrome connect.
   If the first connect does not settle in `CDP_READY_TIMEOUT_MS`, a request
   gets 503 `{"error":"chrome connect timeout"}`.
4. When Chrome goes away, the daemon tries `CDP_MAX_RECONNECT` reconnects,
   one per second, then exits 0.
5. On exit the daemon removes the socket only if the file is the one it bound.

## Tests

```sh
bun test            # 90 unit tests, no browser required
bun run check       # typecheck + lint + format + biome + test
```

The browser-touching pieces are tested with an injected fake socket (see
`lib/connection.test.ts`, `lib/dispatch.test.ts`), so the suite is fast and
hermetic. The live paths were also smoke-tested against a real Chromium.

## Security notes

This tool acts inside the user's real browser session (cookies, logins). Treat
`eval`/`frameeval` like running arbitrary JS in the user's tabs, because that's
what it is. The daemon binds a unix socket under `/tmp`; anyone who can read
that socket can drive the browser, same trust boundary as the debug port
itself.
