Use `ChromeCDP` to drive an already-running Chrome/Chromium over the DevTools Protocol: read open tabs, run JavaScript in a page or a cross-origin iframe, navigate, open/close/focus tabs, drive/track downloads, and (via the generic `send` passthrough) call ANY CDP method and inspect the protocol's async event stream. It acts inside the user's real, logged-in browser.

## Prerequisite

Chrome/Chromium must be running with `--remote-debugging-port=9222`. The tool starts a small background daemon on first use that holds ONE connection to the browser and is reached over a unix socket, so macOS asks for Local Network permission only once.

## When to use `ChromeCDP` vs `Fetch`

- **`Fetch`**: stateless one-shot read of a public URL. No session, no clicking.
- **`ChromeCDP`**: you need the user's logged-in session, to click/eval inside a live page, to walk a multi-step flow, or to read tabs the user already has open.

## Actions

- `ping` - daemon + browser liveness.
- `targets` - list open page tabs as `{id,title,url}`. Start here to get a `target` id.
- `alltargets` - every target including iframes and workers.
- `eval` - run JS in a tab. Needs `target` + `expr`. Result is returned by value; a thrown error comes back as `{"__error":"..."}` (not a crash).
- `frameeval` - run JS in a cross-origin child frame, matched by `urlSub` against frame URLs. Needs `target` + `urlSub` + `expr`. Use for embedded logins / payment iframes that are separate CDP targets.
- `nav` - navigate a tab. Needs `target` + `url`.
- `newtab` - open a tab (optional `url`, defaults about:blank). Returns `{id}`.
- `setdownload` - set a tab's download directory. Needs `target` + `dir` (absolute).
- `downloads` - list tracked downloads with `state` (begin|inProgress|completed|canceled).
- `closetarget` - close a tab. Needs `target`.
- `activatetarget` - focus/bring-to-front a tab. Needs `target`.
- `getinfo` - the full `TargetInfo` for one tab. Needs `target`.
- `send` - **the escape hatch.** Call any CDP method. Needs `method` (`Domain.method`), optional `params` (object), optional `target` (scopes the call to that tab's session) or `sessionId` (advanced, explicit). Returns `{result, sessionId}`. A protocol error comes back as `{result:{__error:"..."}}`, never a crash.
- `events` - drain buffered CDP events (the async push stream). Optional `filter` (substring on method name), `since` (cursor for incremental draining), `sessionId`, `limit`, `clear`. Returns `{recording, cursor, buffered, dropped, count, events}`.
- `record` - toggle event buffering. `on` (default true), optional `clear`. (You rarely need this: `send`-ing any `*.enable` flips recording on automatically.)

## The generic `send` passthrough: full protocol surface

CDP is just JSON-RPC, so `send` forwards any `method`+`params` and gives you the whole protocol without per-domain wiring. A few high-value examples:

- **Screenshot / PDF:** `send Page.captureScreenshot {format:"png"}` (base64 in `result.data`), `send Page.printToPDF {}`.
- **Performance metrics:** `send Performance.enable {}` then `send Performance.getMetrics {}` → `{metrics:[{name,value}]}` (JSHeapUsedSize, Nodes, LayoutCount, ScriptDuration, …).
- **Emulation:** `send Emulation.setDeviceMetricsOverride {width,height,deviceScaleFactor,mobile}`, `setUserAgentOverride`, `setGeolocationOverride`, `setTimezoneOverride`.
- **DOM / a11y:** `send DOM.getDocument {depth:-1}`, `send Accessibility.getFullAXTree {}`.
- **Storage / cookies:** `send Network.getCookies {}`, `send Storage.clearDataForOrigin {...}`.
- **Profiling:** `send Profiler.enable {}` → `Profiler.start` → `Profiler.stop` (CPU profile in the result); `send HeapProfiler.takeHeapSnapshot {}`.

Scope to a tab by passing `target`; omit it for browser-global methods.

## Network / performance inspection (events)

Commands are request/reply, but the interesting network + perf data arrives as **events** (async pushes with no reply). The daemon holds one long-lived socket and buffers them. The loop:

1. **Enable** the domain on the tab: `send` `{method:"Network.enable", target:"<id>"}`. This auto-starts recording.
2. **Make traffic happen** (`nav`, click, etc.).
3. **Drain:** `events` `{filter:"Network"}` → an ordered list of `{seq, ts, method, sessionId, params}`. Key Network events: `Network.requestWillBeSent`, `responseReceived`, `loadingFinished`, `loadingFailed`. Correlate by `params.requestId`.
4. **Incremental draining:** pass the previous response's `cursor` back as `since` to get only what's new.
5. **Response bodies:** once you see `loadingFinished` for a `requestId`, `send Network.getResponseBody {requestId:"..."}` → `{body, base64Encoded}`. Gotcha: the body is only retrievable while Chrome still holds it (call soon after `loadingFinished`); large/evicted bodies may fail.

Other useful event sources: `Log.enable` → `Log.entryAdded`; `Runtime.enable` → `Runtime.consoleAPICalled` / `Runtime.exceptionThrown`; `Page.enable` → lifecycle events. Deep tracing: `Tracing.start {}` → traffic → `Tracing.end {}`, with `Tracing.dataCollected` / `Tracing.tracingComplete` arriving as events.

## How to call it well

- **Get a `target` first.** Call `targets`, pick the id, then act on it.
- **Clicking custom widgets.** `el.click()` often isn't enough for React menus. Dispatch a full event sequence in `expr`:
  ```js
  ["pointerdown","mousedown","pointerup","mouseup","click"].forEach(t =>
    el.dispatchEvent(new MouseEvent(t, {bubbles:true, cancelable:true, view:window})));
  ```
- **Setting a React-controlled input.** Use the native setter so onChange fires:
  ```js
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
  set.call(input,"text"); input.dispatchEvent(new Event("input",{bubbles:true}));
  ```
- **Downloads.** Call `setdownload` first, click, then poll `downloads` until `state:"completed"` before assuming the file exists. One-time downloads are consumed even if the save path wasn't set, so verify.
- **Logins behind a bot check** (Cloudflare Turnstile, etc.) usually can't be scripted. Have the user log in once, then script the same-origin work after.

## Don't

- Don't use it for a plain public page read; use `Fetch`.
- Don't assume a tab is scriptable mid-navigation; `nav`, wait, then `eval`.
- Don't `closetarget` the last remaining tab if you need the connection to survive: closing the final tab can quit Chrome and drop the debug socket. Open a keep-alive `newtab` first.
- Don't expect `events` to show anything before you've enabled the relevant domain. No `*.enable`, no events. The buffer is bounded (oldest evicted; `dropped` tells you how many were lost), so drain with `since` for long captures.
- Don't paste a raw method without the `Domain.` prefix; `send` validates the `Domain.method` shape and rejects bare names.
