import CoreGraphics
import AppKit
import Foundation

/// The identity of the binary file of this process (review M3): the path
/// with no symlinks, the size and the mtime. `ping` gives it as `binary`.
/// The TS client (lib/client.ts `judgePing`) compares it with the file that
/// it would start, and replaces a helper from another build. Daemon mode
/// reads it one time at start (main.swift), so a later rebuild or `touch` of
/// the file does not change the value of a running helper.
enum HelperBinary {
    static let identity: [String: Any]? = read(CommandLine.arguments.first ?? "")

    /// The identity of the file at `arg0`, or nil when it cannot be read.
    /// A relative `arg0` resolves against the current directory, the same as
    /// the exec. An `arg0` with no slash (a PATH lookup) uses the executable
    /// path of the main bundle.
    static func read(_ arg0: String) -> [String: Any]? {
        var path = arg0
        if !path.contains("/") {
            guard let exe = Bundle.main.executablePath else { return nil }
            path = exe
        }
        if !path.hasPrefix("/") {
            path = (FileManager.default.currentDirectoryPath as NSString).appendingPathComponent(path)
        }
        guard let real = realpath(path, nil) else { return nil }
        defer { free(real) }
        let resolved = String(cString: real)
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: resolved),
              let size = (attrs[.size] as? NSNumber)?.int64Value,
              let mtime = attrs[.modificationDate] as? Date else { return nil }
        return ["path": resolved, "size": size, "mtime": mtime.timeIntervalSince1970]
    }
}

/// Maps an HTTP route + JSON body to a service call and a JSON response.
/// Enforces the permission gate and safety guardrails before any action.
enum Router {
    static let version = "0.1.0"

    /// The route protocol. The TS client (lib/client.ts `HELPER_PROTOCOL`)
    /// stops a helper that gives a lower number or none. Increase it when a
    /// route or a field changes in a way that an old helper cannot serve.
    /// 2: the `targets` route and the screenshot modes.
    static let protocolVersion = 2

    /// The version of the helper code (review N1). The TS client
    /// (lib/client.ts `HELPER_VERSION`) replaces a helper with a lower number
    /// and keeps a helper with a higher number. It does not compare the file
    /// mtime of two paths. Bump it on each change to the helper code that
    /// clients must get, and bump `HELPER_VERSION` to the same number.
    static let helperVersion = 3

    static func handle(route: String, rawBody: [String: Any]) -> (status: Int, json: Any) {
        let body = Body(rawBody)

        // Always-available meta routes.
        switch route {
        case "ping":
            var info: [String: Any] = [
                "ok": true,
                "version": version,
                "protocol": protocolVersion,
                "helperVersion": helperVersion,
                "pid": Int(ProcessInfo.processInfo.processIdentifier),
                "perms": Permissions.status(),
                "disabled": Safety.shared.disabled,
            ]
            // M3: the build identity. The protocol stays 2, so an old plugin
            // still accepts this helper and ignores the new field.
            if let binary = HelperBinary.identity { info["binary"] = binary }
            return (200, info)
        case "perms":
            let r = Permissions.handle(prompt: body.bool("prompt") ?? false, pane: body.string("pane"))
            return (200, r)
        default:
            break
        }

        // `apps` only needs NSWorkspace; `screenshot` checks Screen Recording
        // itself. Everything else (AX reads + event posting) needs Accessibility.
        let noAXNeeded: Set<String> = ["apps", "screenshot", "targets"]
        if !noAXNeeded.contains(route), !Permissions.accessibilityTrusted(prompt: false) {
            return (403, [
                "error": "Accessibility permission not granted",
                "perms": Permissions.status(),
                "hint": "Call Computer{action:\"perms\",prompt:true}. " + Permissions.grantHint,
            ])
        }

        // Safety gate for mutating routes.
        if let blocked = Safety.shared.gate(route: route) {
            Safety.shared.log(route: route, body: rawBody, status: 429)
            return (429, blocked)
        }

        // A number that does not fit its native type must not trap the daemon.
        if let message = rangeError(body) {
            Safety.shared.log(route: route, body: rawBody, status: 400)
            return (400, ["error": message])
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
        case "targets":
            result = wrap(TargetsService.targets(
                pid: pidArg(body), bundleId: body.string("bundleId"), title: body.string("title"),
                visibleOnly: body.bool("visibleOnly") ?? true, limit: body.int("limit") ?? 50))
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
            // rangeError already gave 400 for a value that does not fit.
            let dy = body.int("dy").flatMap { Int32(exactly: $0) } ?? 0
            let dx = body.int("dx").flatMap { Int32(exactly: $0) } ?? 0
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
        var req = ShotRequest()
        req.mode = body.string("mode") ?? "screen"
        guard ["screen", "area", "window", "app"].contains(req.mode) else {
            return (400, ["error": "unknown screenshot mode \(req.mode)", "hint": "use screen, area, window or app"])
        }
        req.format = body.string("format") ?? "path"
        req.displayIndex = body.int("display")
        req.displayId = body.int("displayId").flatMap { UInt32(exactly: $0) }
        req.windowId = body.int("windowId").flatMap { UInt32(exactly: $0) }
        req.el = body.string("el")
        req.pid = pidArg(body)
        req.bundleId = body.string("bundleId")
        req.title = body.string("title")
        req.cursor = body.bool("cursor")
        if body.any("maxSize") != nil {
            guard let m = body.int("maxSize"), m >= 64 else {
                return (400, ["error": "maxSize must be a number of 64 or more (long edge in pixels)"])
            }
            req.maxSize = m
        }
        switch req.mode {
        case "area":
            guard let x = body.double("x"), let y = body.double("y"),
                  let w = body.double("w"), let h = body.double("h") else {
                return (400, ["error": "area requires x, y, w and h (global points)"])
            }
            guard w > 0, h > 0 else { return (400, ["error": "area requires w > 0 and h > 0"]) }
            req.rect = CGRect(x: x, y: y, width: w, height: h)
        case "window":
            guard req.windowId != nil || req.el != nil || req.pid != nil || req.bundleId != nil else {
                return (400, ["error": "window mode requires windowId, el, pid or bundleId",
                              "hint": "call Computer{action:\"targets\"} to list windows"])
            }
        case "app":
            guard req.pid != nil || req.bundleId != nil else {
                return (400, ["error": "app mode requires pid or bundleId",
                              "hint": "call Computer{action:\"targets\"} to list apps and windows"])
            }
        default:
            break
        }
        guard let out = resolveOutputDir(body.string("outputDir"), defaultDir: defaultShotDir()) else {
            return (400, ["error": "outputDir must be an absolute path",
                          "hint": "pass a path that starts with / or ~/"])
        }
        req.outputDir = out.dir
        req.defaultDir = out.isDefault
        let r = ScreenshotService.capture(req)
        if r.status != 200 { return (r.status, r.json) }
        return wrap(r.json)
    }

    // MARK: - utils

    /// The body keys that become a fixed-size native integer, with the range
    /// of that type.
    static let ranged: [(key: String, range: ClosedRange<Int64>, type: String)] = [
        ("pid", Int64(Int32.min)...Int64(Int32.max), "pid_t (Int32)"),
        ("windowId", 0...Int64(UInt32.max), "CGWindowID (UInt32)"),
        ("displayId", 0...Int64(UInt32.max), "CGDirectDisplayID (UInt32)"),
        ("dx", Int64(Int32.min)...Int64(Int32.max), "Int32"),
        ("dy", Int64(Int32.min)...Int64(Int32.max), "Int32"),
    ]

    /// A 400 error text when a number in the body does not fit its native
    /// type, else nil. Pure, so the self-test can call it.
    static func rangeError(_ body: Body) -> String? {
        for r in ranged where !body.intFits(r.key, r.range) {
            return "\(r.key) is out of range: it must be an integer from \(r.range.lowerBound) to \(r.range.upperBound) (\(r.type))"
        }
        return nil
    }

    /// The screenshot folder: `~` expanded. Nil when the result is not an
    /// absolute path (a 400 error). `isDefault` compares the same expanded
    /// path with the default folder.
    static func resolveOutputDir(_ raw: String?, defaultDir: String) -> (dir: String, isDefault: Bool)? {
        guard let raw else { return (defaultDir, true) }
        let dir = (raw as NSString).expandingTildeInPath
        guard dir.hasPrefix("/") else { return nil }
        let same = (dir as NSString).standardizingPath == (defaultDir as NSString).standardizingPath
        return (dir, same)
    }

    /// The body `pid`. `rangeError` gave 400 before for a value that does not
    /// fit, so `Int32(exactly:)` never drops a valid pid here.
    private static func pidArg(_ body: Body) -> pid_t? {
        body.int("pid").flatMap { pid_t(exactly: $0) }
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
