Use `Computer` to control this Mac. It has two layers and you should prefer the first:

1. **Accessibility (AX)** - inspect the real UI tree and act on real elements by a stable handle. Reliable, fast, and survives layout shifts better than pixel-hunting.
2. **Raw input** - synthesize mouse/keyboard at screen coordinates, plus screenshots. The last resort, for canvas/Electron/web/game UIs where the AX tree is thin or missing.

Behind the tool is a signed background helper (`ComputerUseHelper.app`) that holds the macOS Accessibility + Screen Recording permissions and auto-starts on first use. Because it is signed with a stable identity, the user grants permission **once** and it persists across rebuilds.

## Prerequisite (one-time)

The helper must be built and granted permission before anything works:

```
cd ma-computer-use-plugin
bun run bin/cud.ts build     # xcodegen + xcodebuild, signs with the dev identity
bun run bin/cud.ts prompt    # fires the permission prompts + opens Settings
```

The user then enables **ComputerUseHelper** in System Settings → Privacy & Security → **Accessibility** and **Screen & System Audio Recording**, and runs `bun run bin/cud.ts restart`. If any action returns a permission error, call `Computer{action:"perms", prompt:true}` and tell the user what to enable.

## Coordinates

All coordinates are **logical points**, **top-left origin**, spanning all displays. AX `bbox` values are `[x, y, width, height]` in this **same** space, so to click an element you can click the center of its bbox directly: `x = bbox[0] + bbox[2]/2`, `y = bbox[1] + bbox[3]/2`. Screenshots report device-pixel `width`/`height` and a `scale`; on a 2x Retina display, halve pixel coordinates from the image before clicking.

## The AX-first workflow

1. `Computer{action:"apps"}` - find the target app (pid + bundleId), or just target the frontmost app by omitting both.
2. `Computer{action:"snapshot", bundleId:"com.apple.TextEdit"}` - get a flat list of elements, each with a handle (`e7`), role, title, value, bbox, and supported actions. Lower `maxNodes` if it's large.
3. `Computer{action:"find", role:"AXButton", title:"Bold"}` - or search directly instead of dumping the whole tree.
4. Act on a handle:
   - `Computer{action:"perform", el:"e7", axAction:"AXPress"}` - click a button (preferred over a coordinate click).
   - `Computer{action:"setValue", el:"e12", value:"new text"}` - set a text field's contents directly.
   - `Computer{action:"getValue", el:"e12"}` / `Computer{action:"describe", el:"e12"}` - read.

Element handles stay valid until the UI changes. If you get a `409` "stale; re-snapshot", just `snapshot` again and use the new handles.

## When AX isn't enough (raw input)

- Move/click: `Computer{action:"mouse", op:"click", x:260, y:150}` (op: move, click, doubleclick, rightclick, middleclick, down, up, drag, scroll; `button`: left/right/center; `clicks`: 1/2/3).
- Drag: `Computer{action:"mouse", op:"drag", x:100, y:100, toX:400, toY:300}`.
- Scroll: `Computer{action:"mouse", op:"scroll", dy:-3, x:500, y:400}` (dy +up/-down lines).
- Type text: `Computer{action:"type", text:"hello world"}` - injects literal Unicode into the focused field (handles emoji/CJK). Click or focus the field first.
- Keys/shortcuts: `Computer{action:"key", combo:"cmd+c"}` or `Computer{action:"keypress", key:"return"}` / `{key:"tab", modifiers:["shift"]}`.
- See the screen: `Computer{action:"screenshot"}` returns a PNG path (or `format:"base64"` for inline bytes, area via `mode:"area", x,y,w,h`).

## Safety - this controls the user's real machine

- There is **no sandbox**. A click or keystroke goes to whatever is on screen. Be deliberate. Read before you write: `snapshot`/`screenshot` to confirm state, then act.
- Prefer AX `perform`/`setValue` over coordinate input - it targets a named element, not a guessed pixel.
- Typing into a **password/secure field is blocked** by macOS; the tool returns a warning rather than silently failing.
- Every mutating action is rate-limited and logged to `~/Library/Logs/ma-computer-use/actions.log`. A kill switch (`bun run bin/cud.ts disable`) makes the helper refuse all input until re-enabled.
- Don't drive destructive flows (delete, erase, log out, purchases, security settings) without the user explicitly asking for that exact action.

## Troubleshooting

- "helper not built" → run `bun run bin/cud.ts build`.
- permission error / 403 → `Computer{action:"perms", prompt:true}`, enable in Settings, then `cud restart`.
- thin/empty snapshot (Electron, Chrome, custom canvas) → fall back to `screenshot` + coordinate `mouse`/`type`. For a browser specifically, prefer the `ChromeCDP` tool.
- stale handle (409) → re-`snapshot`.
