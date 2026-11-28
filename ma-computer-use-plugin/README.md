# ma-computer-use-plugin

Full control of the Mac for [minimal-agent][ma], in two layers:

1. **Accessibility (AX)** - inspect and interact with the real UI tree (preferred).
2. **Raw input** - synthesize mouse/keyboard at coordinates + screenshots (last resort).

Exposes one tool: **`Computer`** (an `action` enum, like `ChromeCDP`).

[ma]: https://github.com/gastonmorixe/minimal-agent-core

## Architecture

```
agent ──Computer tool──► handlers/computer.ts (bun, thin client)
                              │ fetch(http://localhost/<route>, {unix: cud.sock})
                              ▼
                       cud.sock (unix domain socket)
                              ▼
              ComputerUseHelper  (one Swift Mach-O binary, ad-hoc signed)
                ├─ HTTPServer   tiny HTTP/1.1 over AF_UNIX
                ├─ Router       route → service, JSON in/out, perms + safety gates
                ├─ Permissions  AX / Screen Recording / Input Monitoring
                ├─ AXService    snapshot / find / describe / perform / get / set
                ├─ InputService CGEvent mouse + keyboard + scroll + type
                ├─ Screenshot   ScreenCaptureKit one-shot
                └─ Safety       kill switch, bounds clamp, rate limit, action log
```

The daemon is one Mach-O binary that `swiftc` makes. It needs no `.app` bundle
and no `Info.plist`. When a terminal (or the CLI in a terminal) starts the helper,
macOS uses the Accessibility and Screen Recording grants of that **terminal app**.
The helper signature does not change the grants. So give the grants to the
terminal app that runs minimal-agent, not to `ComputerUseHelper`.

IPC is HTTP-over-unix-socket, mirroring `ma-chrome-cdp-plugin`, so the bun client
(`lib/client.ts`) is the proven pattern. A unix socket is a filesystem object, not
"network", so it never triggers the macOS Local Network prompt.

## Requirements

- macOS 14+ (ScreenCaptureKit floor; built/tested on macOS 26).
- `swiftc` (Xcode or the Command Line Tools) and `bun`. `build` needs nothing more.
- Signing is off by default. The linker gives the binary an ad-hoc signature, the
  same on a dev Mac and on CI. `build` never reads the keychain for an identity.
- To sign, set `MA_CU_SIGN_IDENTITY` (for example
  `Developer ID Application: Your Name (TEAMID)`). Then `build` runs
  `codesign --force --options runtime --sign "$MA_CU_SIGN_IDENTITY"`.
- Legacy and optional: `cud notarize` makes a Release `.app` with `xcodegen` +
  `xcodebuild`. It needs a **Developer ID Application** identity in the keychain,
  App Store Connect API key credentials (see "Notarization" below), and the
  `MA_CU_TEAM_ID` and `MA_CU_BUNDLE_ID` values of `native/project.yml`.
  `fastlane` is optional.

## One-time setup

```bash
cd ma-computer-use-plugin

# 1. Compile native/build/ComputerUseHelper (swiftc) and run its --selftest.
bun run bin/cud.ts build

# 2. Fire the permission prompts and open the right Settings panes.
bun run bin/cud.ts prompt

# 3. In System Settings > Privacy & Security, enable the TERMINAL app that runs
#    minimal-agent (for example iTerm or Terminal) under:
#      - Accessibility            (drive + read the UI, required)
#      - Screen & System Audio Recording  (required for screenshot)
#    Input Monitoring is NOT needed (we post events, we don't read the live stream).

# 4. Quit the terminal app and open it again, then restart the helper, so the
#    new grant takes effect.
bun run bin/cud.ts restart

# 5. Confirm.
bun run bin/cud.ts status     # should print perms ax:true screen:true
```

The monorepo checkout loads it automatically. For one project, symlink it into the project plugin root:

```bash
ln -s "$PWD" <project>/.agents/minimal-agent/plugins/ma-computer-use-plugin
```

## Control CLI (`bin/cud.ts`)

| command              | what                                                                            |
| -------------------- | ------------------------------------------------------------------------------- |
| `build`              | `swiftc` → `native/build/ComputerUseHelper` (ad-hoc), then `--selftest`         |
| `notarize`           | legacy, opt-in: Release `.app` + Developer ID sign + notarytool submit + staple |
| `start`              | launch the helper binary as a detached daemon                                   |
| `stop`               | terminate the daemon                                                            |
| `restart`            | stop + start (needed after a permission grant)                                  |
| `status`             | running? + ping the socket (shows version, protocol + perms)                    |
| `logs [N]`           | tail the daemon log                                                             |
| `perms`              | print permission status (runs the binary `--check`)                             |
| `prompt`             | fire permission prompts + open Settings (runs `--prompt`)                       |
| `disable` / `enable` | the kill switch (refuse / allow mutating actions)                               |

The handler and the CLI start `CUD_HELPER` (env) when it is set, else
`native/build/ComputerUseHelper`. They never start the legacy `.app`: it gives no
`protocol`, so the handshake would stop it on each call.

The handler also **auto-starts** the daemon on first tool use, so the agent doesn't
have to call `start`. You still must `build` and grant permissions once.

### Protocol handshake

`ping` gives `protocol` (`Router.protocolVersion` in Swift, `HELPER_PROTOCOL` in
`lib/client.ts`, now `2`). An old helper (an older build, for example the legacy
`.app`) can still hold the socket. Its ping gives no `protocol` or a lower one, and
it has no `targets` route and no new screenshot modes. Then the handler:

1. Sends `SIGTERM` to the pid that the ping gave. It never kills another pid, pid 1
   or its own pid.
2. Waits up to 2 s until the socket stops answering.
3. Starts the new helper and pings it again.

A ping with no answer in 2 s (the helper is busy with a long request) gives the
error "the computer-use helper is busy with another request, try again". The
handler does not kill it and does not start a second helper. A spawn lock
(`<socket>.spawn.lock`) lets one caller at a time stop or start a helper. When a
helper that this handler started is old itself, later calls give the same error
and do not stop it again.

If the kill fails, or the old helper does not stop in 2 s, the tool gives an error
that tells the user to quit the `ComputerUseHelper` process. Increase both numbers
together when a route or a field changes in a way that an old helper cannot serve.

All checkouts and the compiled CLI share one socket. So `ping` also gives
`helperVersion` (`Router.helperVersion` in Swift, `HELPER_VERSION` in
`lib/client.ts`, now `3`), and the handler uses these rules in this sequence:

1. A lower `protocol`, or none: stop the helper and start this one.
2. A higher `protocol`: keep the helper. A client never stops a newer helper.
3. A lower `helperVersion` (none counts as `0`): stop the helper and start this one.
4. A higher `helperVersion`: keep the helper.
5. The same `helperVersion` at the same path, with another size or mtime: stop
   the helper and start this one. This is a rebuild of the same version.
6. The same `helperVersion` at another path: keep the helper. The code is the same.

The handler does not compare the mtime of two paths. The mtime is the time of the
build or of the extract, not the age of the code. Increase both `helperVersion`
numbers together on each change to the helper code that clients must get.

## Tool usage (`Computer`)

AX-first. The tool and parameter descriptions in `manifest.json` are the agent-facing guide. Quick tour:

```jsonc
{"action":"apps"}                                    // list GUI apps
{"action":"snapshot","bundleId":"com.apple.TextEdit"} // flat element list w/ handles
{"action":"find","role":"AXButton","title":"Bold"}    // search the tree
{"action":"perform","el":"e7","axAction":"AXPress"}   // click a real element
{"action":"setValue","el":"e12","value":"hello"}      // set a text field
{"action":"mouse","op":"click","x":260,"y":150}       // raw click (points, top-left)
{"action":"type","text":"hello world"}                // inject text into focus
{"action":"key","combo":"cmd+s"}                      // shortcut
{"action":"targets","bundleId":"com.apple.TextEdit"} // display + window ids
{"action":"screenshot","maxSize":1200}                // main display, long edge <= 1200 px
{"action":"screenshot","mode":"area","x":0,"y":0,"w":800,"h":600}
{"action":"screenshot","mode":"window","windowId":4711} // one window, also covered parts
{"action":"screenshot","mode":"app","bundleId":"com.apple.finder"}
{"action":"perms","prompt":true}                      // request missing permissions
```

Coordinates are **logical points, top-left origin**, across all displays. AX `bbox`
is `[x,y,w,h]` in the same space, so click an element at `x=bbox[0]+bbox[2]/2`,
`y=bbox[1]+bbox[3]/2`.

### Screenshots

1. `targets` lists the displays (`index`, `displayId`, `bbox`, `scale`, `main`) and
   the windows (`windowId`, `pid`, `bundleId`, `app`, `title`, `bbox`, `layer`,
   `onScreen`, `display`), front to back. Filters: `pid`, `bundleId`, `title`
   (case-insensitive text), `visibleOnly` (default `true`), `limit` (default 50).
2. `screenshot` modes: `screen` (`display` index or `displayId`, default the main
   display), `area` (`x`, `y`, `w`, `h` in global points, all four necessary),
   `window` (`windowId`, `el`, or `pid`/`bundleId` with an optional `title`), and
   `app` (`pid` or `bundleId`). `window` and `app` have no default target.
3. `maxSize` (64 or more) limits the long edge in pixels. `cursor` shows the
   pointer (default on for `screen` and `area`).
4. The result has `mode`, `bbox` (global points), `scale` (output pixels per
   point, `width / bbox.w`), `display` and `displayId`. A pixel `(px, py)` is the
   point `(bbox[0] + px / scale, bbox[1] + py / scale)`.
5. A `window` capture shows the window content also when another window covers
   it. Then the result has `occluded: true`. Raise the window (`activate`, or
   `perform` with `AXRaise`) before a click.
6. `windows` gives a `windowId` for each window when Screen Recording is granted.
   Else it adds `windowIdError` and never prompts.
7. A display index is valid only until the display setup changes. `displayId` is
   stable.
8. Stage Manager: a window in the side strip is a small thumbnail for the window
   server. A `window` capture then gives the thumbnail, and its `bbox` is the
   thumbnail frame, not the AX frame. Use `activate` on the app first to capture
   the full window.

## Safety

This controls the real machine, unsandboxed. Built-in guardrails (defaults on):

- **Kill switch** - `cud disable` (or `CUD_DISABLED=1`) makes the daemon refuse all
  mutating actions; reads still work. `cud enable` clears it. The tool error names
  the switch that is on (the env var or the flag file), so a user with no `cud`
  can clear it.
- **Coordinate clamp** - mouse ops are clamped to the union of display bounds.
- **Rate limit** - mutating actions are capped (~20/s).
- **Audit log** - every mutating action is appended (JSONL) to
  `~/Library/Logs/ma-computer-use/actions.log`; typed text is redacted.
- **Secure input** - typing into a password field is blocked by macOS; the tool
  reports a warning instead of failing silently.

## Notarization (optional, for distribution)

For local use you don't need notarization (Gatekeeper only blocks _quarantined_
downloads, and a locally built app has no quarantine flag). Notarize only if you
want to copy the `.app` to **another** Mac without Gatekeeper warnings.

The flow is automated:

```bash
cd ma-computer-use-plugin
bun run bin/cud.ts notarize          # Release build → Developer ID sign → notarytool → staple
```

This runs `native/sign-and-notarize.sh`, which:

1. Re-signs with the **Developer ID Application** identity, `--options runtime`,
   `--timestamp`, and `native/Sources/ComputerUseHelper.release.entitlements`
   (sandbox off, **no `get-task-allow`** - notarization rejects that entitlement).
2. Zips with `ditto` and submits via `xcrun notarytool submit --wait`.
3. `xcrun stapler staple`s the ticket so the app validates offline.

Result: `spctl -a -vvv --type exec` reports `accepted / source=Notarized Developer ID`.

What it needs (kept OUT of this repo, never committed):

- A **Developer ID Application** signing identity in the login keychain.
- An **App Store Connect API key** (`.p8`) + key id + issuer id, referenced by a
  `notary-credentials.env` file. The script's default path points at a private,
  gitignored directory outside the repo; override by passing a second argument:
  `bash native/sign-and-notarize.sh native/build/ComputerUseHelper.app /path/to/notary-credentials.env`.

`notary-credentials.env` format:

```sh
NOTARY_KEY_ID=XXXXXXXXXX
NOTARY_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
NOTARY_KEY_FILE=AuthKey_XXXXXXXXXX.p8   # relative to this file's dir, or absolute
TEAM_ID=TEAMID0000
```

Note: the signature does not change the grants when a terminal starts the helper.
macOS uses the grants of the terminal app.

The fastlane equivalent is `cd native && fastlane mac notarize`.

## Files

```
manifest.json            # declares the Computer tool
handlers/computer.ts     # tool handler (thin unix-socket client)
bin/cud.ts               # control CLI + auto-spawn
lib/{client,embedded-helper,missing-helper,paths,render,routes,spawn-lock,style,types}.ts
ui/setup.ts              # CLI only: installs the terminal kit into the style slots
native/
  Sources/*.swift        # the daemon (build compiles these with swiftc)
  Sources/ComputerUseHelper*.entitlements   # legacy notarize only
  project.yml            # XcodeGen spec, legacy notarize only
  fastlane/Fastfile      # legacy .app build/sign (+ notarization seam)
  build/ComputerUseHelper   # the helper binary (gitignored)
```

## Testing & dev

```bash
bun test            # bun-side unit tests
bun run bin/cud.ts build      # swiftc + --selftest + codesign -dv
bun run bin/cud.ts restart
```

To test the grant flow again, remove the terminal app from the Accessibility and
Screen Recording lists in System Settings > Privacy & Security.
