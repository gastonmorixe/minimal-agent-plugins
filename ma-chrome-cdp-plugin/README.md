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
manifest.json            tool registration (ChromeCDP) + input schema
PROMPT.md                model-facing usage guidance
handlers/chrome_cdp.ts   tool handler (thin shell over lib/)
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
  types.ts               local minimal-agent contract stubs
*.test.ts                bun tests (117 across the modules)
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

| Var        | Default               | Meaning                                 |
| ---------- | --------------------- | --------------------------------------- |
| `CDP_PORT` | `9222`                | Chrome remote-debugging port            |
| `CDP_SOCK` | `/tmp/cdp.sock`       | unix socket the daemon listens on       |
| `CDP_DTAP` | auto-detected         | path to `DevToolsActivePort` (override) |
| `CDP_LOG`  | `/tmp/cdp-server.log` | daemon log file                         |

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
