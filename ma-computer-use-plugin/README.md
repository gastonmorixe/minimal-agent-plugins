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
              ComputerUseHelper.app  (signed Swift daemon, LSUIElement)
                ├─ HTTPServer   tiny HTTP/1.1 over AF_UNIX
                ├─ Router       route → service, JSON in/out, perms + safety gates
                ├─ Permissions  AX / Screen Recording / Input Monitoring
                ├─ AXService    snapshot / find / describe / perform / get / set
                ├─ InputService CGEvent mouse + keyboard + scroll + type
                ├─ Screenshot   ScreenCaptureKit one-shot
                └─ Safety       kill switch, bounds clamp, rate limit, action log
```

The daemon is a **signed `.app`** because macOS TCC keys permission grants on the
code signature (bundle id `dev.gastonmorixe.computeruse` + team `RRF7B9FTY3`). A
long-running signed helper is granted Accessibility + Screen Recording **once** and
the grant survives rebuilds. The bun side never touches AX/CGEvent, so `bun` never
appears in the privacy panes (which would mis-attribute the grant and silently fail).

IPC is HTTP-over-unix-socket, mirroring `ma-chrome-cdp-plugin`, so the bun client
(`lib/client.ts`) is the proven pattern. A unix socket is a filesystem object, not
"network", so it never triggers the macOS Local Network prompt.

## Requirements

- macOS 14+ (ScreenCaptureKit floor; built/tested on macOS 26).
- Xcode + command-line tools, `xcodegen`, `bun`. `fastlane` optional (CI path).
- An Apple **Development** signing identity in the login keychain for the local
  Debug build. This repo's build is wired to
  `Apple Development: Gaston Morixe (3M6ZXQCBG9)` / team `RRF7B9FTY3` (see
  `native/project.yml`). Change those two values to use a different account.
- For the **notarized** build (optional, `cud notarize`): a **Developer ID
  Application** identity in the keychain + App Store Connect API key credentials
  (see "Notarization" below).

## One-time setup

```bash
cd ma-computer-use-plugin

# 1. Build + sign the helper .app (xcodegen + xcodebuild).
bun run bin/cud.ts build

# 2. Fire the permission prompts and open the right Settings panes.
bun run bin/cud.ts prompt

# 3. In System Settings → Privacy & Security, enable "ComputerUseHelper" under:
#      - Accessibility            (drive + read the UI; required)
#      - Screen & System Audio Recording  (screenshots; required for screenshot)
#    Input Monitoring is NOT needed (we post events, we don't read the live stream).

# 4. Restart the helper so the new grant takes effect.
bun run bin/cud.ts restart

# 5. Confirm.
bun run bin/cud.ts status     # should print perms ax:true screen:true
```

Install into the agent by symlinking into the home plugin root:

```bash
ln -s "$PWD" ~/.agents/plugins/ma-computer-use-plugin
```

## Control CLI (`bin/cud.ts`)

| command              | what                                                                             |
| -------------------- | -------------------------------------------------------------------------------- |
| `build`              | xcodegen generate + xcodebuild + dev-sign → `native/build/ComputerUseHelper.app` |
| `notarize`           | Release build + Developer ID sign + notarytool submit + staple                   |
| `start`              | launch the signed `.app` as a detached daemon                                    |
| `stop`               | terminate the daemon                                                             |
| `restart`            | stop + start (needed after granting TCC)                                         |
| `status`             | running? + ping the socket (shows version + perms)                               |
| `logs [N]`           | tail the daemon log                                                              |
| `perms`              | print permission status (runs the app `--check`)                                 |
| `prompt`             | fire permission prompts + open Settings (runs `--prompt`)                        |
| `disable` / `enable` | the kill switch (refuse / allow mutating actions)                                |

The handler also **auto-starts** the daemon on first tool use, so the agent doesn't
have to call `start`. You still must `build` and grant permissions once.

## Tool usage (`Computer`)

AX-first. See `PROMPT.md` for the full agent-facing guide. Quick tour:

```jsonc
{"action":"apps"}                                    // list GUI apps
{"action":"snapshot","bundleId":"com.apple.TextEdit"} // flat element list w/ handles
{"action":"find","role":"AXButton","title":"Bold"}    // search the tree
{"action":"perform","el":"e7","axAction":"AXPress"}   // click a real element
{"action":"setValue","el":"e12","value":"hello"}      // set a text field
{"action":"mouse","op":"click","x":260,"y":150}       // raw click (points, top-left)
{"action":"type","text":"hello world"}                // inject text into focus
{"action":"key","combo":"cmd+s"}                      // shortcut
{"action":"screenshot"}                               // PNG path (+ width/height/scale)
{"action":"perms","prompt":true}                      // request missing permissions
```

Coordinates are **logical points, top-left origin**, across all displays. AX `bbox`
is `[x,y,w,h]` in the same space, so click an element at `x=bbox[0]+bbox[2]/2`,
`y=bbox[1]+bbox[3]/2`. Screenshots report device-pixel size + `scale` (halve on 2x).

## Safety

This controls the real machine, unsandboxed. Built-in guardrails (defaults on):

- **Kill switch** - `cud disable` (or `CUD_DISABLED=1`) makes the daemon refuse all
  mutating actions; reads still work. `cud enable` clears it.
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
TEAM_ID=RRF7B9FTY3
```

Note: switching from Apple Development to Developer ID changes the signature, but
because the **bundle id is unchanged and both are team-anchored**, the existing
Accessibility/Screen-Recording TCC grants carry over (no re-approval needed).

The fastlane equivalent is `cd native && fastlane mac notarize`.

## Files

```
manifest.json            # declares the Computer tool
PROMPT.md                # agent-facing tool guide
handlers/computer.ts     # tool handler (thin unix-socket client)
bin/cud.ts               # control CLI + auto-spawn
lib/{client,routes,render,paths,types}.ts
native/
  project.yml            # XcodeGen spec
  Sources/*.swift        # the daemon
  Sources/ComputerUseHelper.entitlements
  fastlane/Fastfile      # CI build/sign (+ notarization seam)
  build/                 # ComputerUseHelper.app (gitignored)
```

## Testing & dev

```bash
bun test            # bun-side unit tests
bun run bin/cud.ts build && bun run bin/cud.ts restart
tccutil reset Accessibility dev.gastonmorixe.computeruse   # reset to re-test the grant flow
tccutil reset ScreenCapture dev.gastonmorixe.computeruse
```
