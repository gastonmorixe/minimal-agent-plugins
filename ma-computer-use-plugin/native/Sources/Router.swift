import CoreGraphics
import AppKit
import Foundation

/// Maps an HTTP route + JSON body to a service call and a JSON response.
/// Enforces the permission gate and safety guardrails before any action.
enum Router {
    static let version = "0.1.0"

    static func handle(route: String, rawBody: [String: Any]) -> (status: Int, json: Any) {
        let body = Body(rawBody)

        // Always-available meta routes.
        switch route {
        case "ping":
            return (200, [
                "ok": true,
                "version": version,
                "pid": Int(ProcessInfo.processInfo.processIdentifier),
                "perms": Permissions.status(),
                "disabled": Safety.shared.disabled,
            ])
        case "perms":
            let r = Permissions.handle(prompt: body.bool("prompt") ?? false, pane: body.string("pane"))
            return (200, r)
        default:
            break
        }

        // `apps` only needs NSWorkspace; `screenshot` checks Screen Recording
        // itself. Everything else (AX reads + event posting) needs Accessibility.
        let noAXNeeded: Set<String> = ["apps", "screenshot"]
        if !noAXNeeded.contains(route), !Permissions.accessibilityTrusted(prompt: false) {
            return (403, [
                "error": "Accessibility permission not granted to ComputerUseHelper",
                "perms": Permissions.status(),
                "hint": "Call Computer{action:\"perms\",prompt:true} then enable ComputerUseHelper in System Settings → Accessibility, then run: cud restart.",
            ])
        }

        // Safety gate for mutating routes.
        if let blocked = Safety.shared.gate(route: route) {
            Safety.shared.log(route: route, body: rawBody, status: 429)
            return (429, blocked)
        }

        // For input routes, optionally bring a target app frontmost first so
        // keystrokes/clicks land in it (keyboard input requires the app active).
        if ["type", "key", "keypress", "mouse"].contains(route),
           body.string("bundleId") != nil || body.int("pid") != nil {
            if AXService.activate(pid: pidArg(body), bundleId: body.string("bundleId")) {
                usleep(150_000)  // let the activation settle
            }
        }

        let result: (status: Int, json: Any)
        switch route {
        case "apps":
            result = (200, ["apps": AXService.apps()])
        case "activate":
            let ok = AXService.activate(pid: pidArg(body), bundleId: body.string("bundleId"))
            result = ok ? (200, ["ok": true]) : (200, ["error": "app not found"])
        case "windows":
            result = wrap(AXService.windows(pid: pidArg(body), bundleId: body.string("bundleId")))
        case "snapshot":
            var opts = AXService.SnapshotOptions()
            if let d = body.int("maxDepth") { opts.maxDepth = d }
            if let n = body.int("maxNodes") { opts.maxNodes = n }
            if let v = body.bool("visibleOnly") { opts.visibleOnly = v }
            if let f = body.bool("flatten") { opts.flatten = f }
            result = wrap(AXService.snapshot(pid: pidArg(body), bundleId: body.string("bundleId"), options: opts))
        case "find":
            result = wrap(AXService.find(
                role: body.string("role"), title: body.string("title"),
                identifier: body.string("identifier"), valueContains: body.string("valueContains"),
                pid: pidArg(body), bundleId: body.string("bundleId"),
                limit: body.int("limit") ?? 25))
        case "elementAtPoint":
            guard let x = body.cgFloat("x"), let y = body.cgFloat("y") else {
                result = (400, ["error": "elementAtPoint requires x and y"]); break
            }
            result = wrap(AXService.elementAtPoint(x: x, y: y))
        case "focused":
            result = wrap(AXService.focused())
        case "describe":
            guard let el = body.string("el") else { result = (400, ["error": "describe requires el"]); break }
            result = wrap(AXService.describe(handle: el))
        case "getValue":
            guard let el = body.string("el") else { result = (400, ["error": "getValue requires el"]); break }
            result = wrap(AXService.getValue(handle: el))
        case "setValue":
            guard let el = body.string("el"), let v = body.any("value") else {
                result = (400, ["error": "setValue requires el and value"]); break
            }
            result = wrap(AXService.setValue(handle: el, value: v))
        case "perform":
            guard let el = body.string("el"), let action = body.string("axAction") else {
                result = (400, ["error": "perform requires el and axAction"]); break
            }
            result = wrap(AXService.perform(handle: el, action: action))
        case "mouse":
            result = handleMouse(body)
        case "type":
            guard let text = body.string("text") else { result = (400, ["error": "type requires text"]); break }
            if InputService.secureInputActive() {
                result = (200, ["ok": false, "warning": "secure input is active (password field); keystrokes blocked"])
            } else {
                InputService.typeString(text)
                result = (200, ["ok": true, "typed": text.count])
            }
        case "key", "keypress":
            result = handleKey(body)
        case "screenshot":
            result = handleScreenshot(body)
        default:
            result = (404, ["error": "unknown route \(route)"])
        }

        Safety.shared.log(route: route, body: rawBody, status: result.status)
        return result
    }

    // MARK: - Sub-handlers

    private static func handleMouse(_ body: Body) -> (status: Int, json: Any) {
        let op = body.string("op") ?? "move"
        let button = parseButton(body.string("button"))
        func point() -> CGPoint? {
            guard let x = body.cgFloat("x"), let y = body.cgFloat("y") else { return nil }
            return Safety.shared.clamp(CGPoint(x: x, y: y))
        }
        switch op {
        case "move":
            guard let p = point() else { return (400, ["error": "mouse move requires x,y"]) }
            InputService.move(to: p)
            return (200, ["ok": true])
        case "click", "leftclick":
            guard let p = point() else { return (400, ["error": "mouse click requires x,y"]) }
            InputService.click(at: p, button: button, clicks: body.int("clicks") ?? 1)
            return (200, ["ok": true])
        case "doubleclick":
            guard let p = point() else { return (400, ["error": "mouse doubleclick requires x,y"]) }
            InputService.click(at: p, button: .left, clicks: 2)
            return (200, ["ok": true])
        case "rightclick":
            guard let p = point() else { return (400, ["error": "mouse rightclick requires x,y"]) }
            InputService.click(at: p, button: .right, clicks: 1)
            return (200, ["ok": true])
        case "middleclick":
            guard let p = point() else { return (400, ["error": "mouse middleclick requires x,y"]) }
            InputService.click(at: p, button: .center, clicks: 1)
            return (200, ["ok": true])
        case "down":
            guard let p = point() else { return (400, ["error": "mouse down requires x,y"]) }
            InputService.mouseDown(at: p, button: button)
            return (200, ["ok": true])
        case "up":
            guard let p = point() else { return (400, ["error": "mouse up requires x,y"]) }
            InputService.mouseUp(at: p, button: button)
            return (200, ["ok": true])
        case "drag":
            guard let x = body.cgFloat("x"), let y = body.cgFloat("y"),
                  let tx = body.cgFloat("toX"), let ty = body.cgFloat("toY") else {
                return (400, ["error": "mouse drag requires x,y,toX,toY"])
            }
            let from = Safety.shared.clamp(CGPoint(x: x, y: y))
            let to = Safety.shared.clamp(CGPoint(x: tx, y: ty))
            InputService.drag(from: from, to: to, button: button, steps: body.int("steps") ?? 20)
            return (200, ["ok": true])
        case "scroll":
            let dy = Int32(body.int("dy") ?? 0)
            let dx = Int32(body.int("dx") ?? 0)
            InputService.scroll(dyLines: dy, dxLines: dx, at: point())
            return (200, ["ok": true])
        default:
            return (400, ["error": "unknown mouse op \(op)"])
        }
    }

    private static func handleKey(_ body: Body) -> (status: Int, json: Any) {
        if InputService.secureInputActive() {
            return (200, ["ok": false, "warning": "secure input is active; key events blocked"])
        }
        if let combo = body.string("combo") {
            guard let (code, flags) = Keycodes.parseCombo(combo) else {
                return (400, ["error": "unrecognized key combo: \(combo)"])
            }
            InputService.keyPress(code: code, flags: flags, holdMs: body.int("holdMs") ?? 0)
            return (200, ["ok": true])
        }
        if let key = body.string("key") {
            guard let code = Keycodes.keycode(for: key) else {
                return (400, ["error": "unrecognized key: \(key)"])
            }
            var flags: CGEventFlags = []
            for m in body.stringArray("modifiers") ?? [] {
                if let f = Keycodes.modifier(for: m) { flags.insert(f) }
            }
            InputService.keyPress(code: code, flags: flags, holdMs: body.int("holdMs") ?? 0)
            return (200, ["ok": true])
        }
        return (400, ["error": "key requires combo or key"])
    }

    private static func handleScreenshot(_ body: Body) -> (status: Int, json: Any) {
        let mode = body.string("mode") ?? "screen"
        let format = body.string("format") ?? "path"
        var rect: CGRect?
        if mode == "area",
           let x = body.cgFloat("x"), let y = body.cgFloat("y"),
           let w = body.cgFloat("w"), let h = body.cgFloat("h") {
            rect = CGRect(x: x, y: y, width: w, height: h)
        }
        let outputDir = body.string("outputDir") ?? defaultShotDir()
        let r = ScreenshotService.capture(
            mode: mode, rect: rect, displayIndex: body.int("display"),
            format: format, outputDir: outputDir)
        return wrap(r)
    }

    // MARK: - utils

    private static func pidArg(_ body: Body) -> pid_t? {
        if let p = body.int("pid") { return pid_t(p) }
        return nil
    }

    private static func parseButton(_ s: String?) -> CGMouseButton {
        switch (s ?? "left").lowercased() {
        case "right": return .right
        case "center", "middle": return .center
        default: return .left
        }
    }

    private static func wrap(_ dict: [String: Any]) -> (status: Int, json: Any) {
        if let _ = dict["error"] {
            if dict["stale"] as? Bool == true { return (409, dict) }
            return (200, dict)  // soft errors (app not found etc) returned 200 with error field
        }
        return (200, dict)
    }

    private static func defaultShotDir() -> String {
        let dir = (NSHomeDirectory() as NSString)
            .appendingPathComponent("Library/Application Support/ma-computer-use/screenshots")
        return dir
    }
}
