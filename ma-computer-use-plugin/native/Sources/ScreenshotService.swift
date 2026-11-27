import ScreenCaptureKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import Foundation

/// A validated `screenshot` request. The Router checks the shape (400 errors)
/// before it makes one.
struct ShotRequest {
    var mode = "screen"
    var displayIndex: Int?
    var displayId: UInt32?
    /// `area` only: the rect in global points.
    var rect: CGRect?
    var windowId: UInt32?
    var el: String?
    var pid: Int32?
    var bundleId: String?
    var title: String?
    var maxSize: Int?
    var cursor: Bool?
    var format = "path"
    var outputDir = ""
    /// True when `outputDir` is the default folder. Only then retention runs.
    var defaultDir = false
}

/// One-shot screen capture via ScreenCaptureKit. The completion-handler API is
/// bridged to a synchronous call with `Bridge.wait` (a semaphore with a
/// timeout) because the daemon's work queue is serial and SCKit's callback
/// runs on its own internal queue (no deadlock). Requires Screen Recording
/// TCC permission.
///
/// Geometry comes from `SCDisplay.frame` and `SCContentFilter.pointPixelScale`
/// and `contentRect`. No code here uses `NSScreen`.
enum ScreenshotService {
    /// A failure with its HTTP status and the soft-error body.
    struct Failure: Error {
        let status: Int
        let json: [String: Any]
    }

    static func fail(_ message: String, hint: String? = nil, status: Int = 200,
                     extra: [String: Any] = [:]) -> Failure {
        var d = extra
        d["error"] = message
        if let hint { d["hint"] = hint }
        return Failure(status: status, json: d)
    }

    static let targetsHint = "call Computer{action:\"targets\"} to list displays and windows"

    static func capture(_ req: ShotRequest) -> (status: Int, json: [String: Any]) {
        if !Permissions.screenRecordingGranted() {
            // Trigger the prompt path; report not-granted.
            Permissions.requestScreenRecording()
            return (200, ["error": "screen recording permission not granted",
                          "hint": "Call perms with prompt:true. " + Permissions.grantHint])
        }
        guard #available(macOS 14.0, *) else {
            return (200, ["error": "screenshot needs macOS 14 or later"])
        }
        let plan: Plan
        do { plan = try makePlan(req) } catch let f as Failure {
            return (f.status, f.json)
        } catch {
            return (200, Bridge.softError("window list failed", error))
        }
        let image: CGImage
        do { image = try captureImageSync(filter: plan.filter, config: plan.config) } catch {
            var d = Bridge.softError("capture failed", error)
            d["mode"] = req.mode
            // A timeout keeps its own hint.
            if req.mode == "window", !Bridge.isTimeout(error) {
                d["windowId"] = plan.meta["windowId"]
                d["onScreen"] = plan.meta["onScreen"] ?? false
                d["hint"] = "the window can be minimized or on another Space. Show it, then try again."
            }
            return (200, d)
        }
        do { return (200, try output(image, plan: plan, req: req)) } catch let f as Failure {
            return (f.status, f.json)
        } catch {
            return (200, ["error": "write failed: \(error.localizedDescription)"])
        }
    }

    // MARK: - Plan

    @available(macOS 14.0, *)
    struct Plan {
        let filter: SCContentFilter
        let config: SCStreamConfiguration
        /// The captured area in global points, after the clip.
        let bbox: CGRect
        let displayIndex: Int?
        let displayId: UInt32?
        var meta: [String: Any]
    }

    @available(macOS 14.0, *)
    static func makePlan(_ req: ShotRequest) throws -> Plan {
        switch req.mode {
        case "screen": return try screenPlan(req)
        case "area": return try areaPlan(req)
        case "window": return try windowPlan(req)
        case "app": return try appPlan(req)
        // The Router gives 400 for an unknown mode. This is a safe guard only.
        default: throw fail("unknown screenshot mode \(req.mode)")
        }
    }

    @available(macOS 14.0, *)
    static func pixelScale(_ filter: SCContentFilter) -> Double {
        let s = Double(filter.pointPixelScale)
        return s > 0 ? s : 1
    }

    /// The display from `displayId` or `display`, or nil when neither is
    /// given. A value that names no display is a 400 error.
    @available(macOS 14.0, *)
    static func explicitDisplay(_ req: ShotRequest, _ content: SCShareableContent) throws -> Int? {
        let displays = content.displays
        if let id = req.displayId {
            guard let i = displays.firstIndex(where: { $0.displayID == id }) else {
                throw fail("displayId \(id) not found", hint: TargetsService.displayHint(content), status: 400)
            }
            return i
        }
        if let idx = req.displayIndex {
            guard idx >= 0, idx < displays.count else {
                throw fail("display \(idx) out of range (0..\(displays.count - 1))",
                           hint: TargetsService.displayHint(content), status: 400)
            }
            return idx
        }
        return nil
    }

    @available(macOS 14.0, *)
    static func mainIndex(_ content: SCShareableContent) -> Int {
        content.displays.firstIndex(where: { $0.displayID == CGMainDisplayID() }) ?? 0
    }

    @available(macOS 14.0, *)
    static func baseConfig(points: CGSize, scale: Double, maxSize: Int?, cursor: Bool) -> SCStreamConfiguration {
        let cfg = SCStreamConfiguration()
        let size = Geometry.outputSize(points: points, scale: scale, maxSize: maxSize)
        cfg.width = size.width
        cfg.height = size.height
        cfg.scalesToFit = true
        cfg.showsCursor = cursor
        return cfg
    }

    @available(macOS 14.0, *)
    static func screenPlan(_ req: ShotRequest) throws -> Plan {
        let content = try TargetsService.shareableContent(onScreenOnly: true)
        guard !content.displays.isEmpty else { throw fail("no display found") }
        let idx = try explicitDisplay(req, content) ?? mainIndex(content)
        let d = content.displays[idx]
        let filter = SCContentFilter(display: d, excludingWindows: [])
        let cfg = baseConfig(points: d.frame.size, scale: pixelScale(filter),
                             maxSize: req.maxSize, cursor: req.cursor ?? true)
        return Plan(filter: filter, config: cfg, bbox: d.frame, displayIndex: idx, displayId: d.displayID, meta: [:])
    }

    @available(macOS 14.0, *)
    static func areaPlan(_ req: ShotRequest) throws -> Plan {
        // The Router checks x, y, w and h (400). Only unwrap the rect here.
        guard let r = req.rect else { throw fail("area has no rect") }
        let content = try TargetsService.shareableContent(onScreenOnly: true)
        let frames = content.displays.map(\.frame)
        let idx: Int
        if let e = try explicitDisplay(req, content) {
            idx = e
        } else if let p = Geometry.pickDisplay(for: r, displays: frames) {
            idx = p
        } else {
            throw fail("area is not on a display", hint: TargetsService.displayHint(content))
        }
        guard let clipped = Geometry.clip(r, to: frames[idx]) else {
            throw fail("area is not on display \(idx)", hint: TargetsService.displayHint(content))
        }
        let d = content.displays[idx]
        let filter = SCContentFilter(display: d, excludingWindows: [])
        let cfg = baseConfig(points: clipped.size, scale: pixelScale(filter),
                             maxSize: req.maxSize, cursor: req.cursor ?? true)
        cfg.sourceRect = Geometry.globalToLocal(clipped, displayFrame: d.frame)
        return Plan(filter: filter, config: cfg, bbox: clipped, displayIndex: idx, displayId: d.displayID, meta: [:])
    }

    @available(macOS 14.0, *)
    static func windowPlan(_ req: ShotRequest) throws -> Plan {
        let content = try TargetsService.shareableContent(onScreenOnly: false)
        // One read of the Core Graphics list for the plan and the occluded check.
        let cg = TargetsService.cgWindows(onScreenOnly: false)
        let list = TargetsService.windows(content: content, onScreenOnly: false, cg: cg)
        let own = TargetsService.ownPid
        let target: SCWindow
        var matches = 1
        if let wid = req.windowId {
            guard let w = content.windows.first(where: { $0.windowID == wid }),
                  w.owningApplication?.processID != own else {
                throw fail("window \(wid) not found, use targets", hint: targetsHint)
            }
            target = w
        } else if let el = req.el {
            guard let ax = AXService.liveElement(el) else {
                throw Failure(status: 409, json: AXService.staleError(el))
            }
            guard let pid = ax.pid, let frame = ax.frame else {
                throw fail("el \(el) has no pid or frame", hint: "pass a window el from the windows action")
            }
            let keys = list.filter { $0.pid == pid }
                .map { Geometry.WindowKey(id: $0.id, pid: $0.pid, frame: $0.bbox, title: $0.title) }
            let ids = Geometry.matchWindowIds(pid: pid, frame: frame, title: ax.title, in: keys)
            if ids.count > 1 {
                throw fail("el \(el) matches more than one window", hint: "pass one windowId",
                           extra: ["candidates": ids.map { Int($0) }])
            }
            guard let id = ids.first, let w = content.windows.first(where: { $0.windowID == id }) else {
                throw fail("no window matches el \(el), use targets", hint: targetsHint)
            }
            target = w
        } else if req.pid != nil || req.bundleId != nil {
            let needle = req.title?.lowercased() ?? ""
            let found = list.filter { w in
                if let p = req.pid, w.pid != p { return false }
                if let b = req.bundleId, w.bundleId != b { return false }
                if !TargetsService.bigEnough(w.bbox) { return false }
                return needle.isEmpty || (w.title ?? "").lowercased().contains(needle)
            }
            guard let first = found.first else {
                throw fail("no window of that app matches, use targets", hint: targetsHint)
            }
            target = first.sc
            matches = found.count
        } else {
            // The Router gives 400 when no target is given. A safe guard only.
            throw fail("window mode needs windowId, el, pid or bundleId", hint: targetsHint)
        }

        let bbox = target.frame
        let frames = content.displays.map(\.frame)
        let idx = Geometry.largestOverlap(bbox, displays: frames)
        let filter = SCContentFilter(desktopIndependentWindow: target)
        let cfg = baseConfig(points: filter.contentRect.size, scale: pixelScale(filter),
                             maxSize: req.maxSize, cursor: req.cursor ?? false)
        cfg.ignoreShadowsSingleWindow = true
        if #available(macOS 14.2, *) { cfg.includeChildWindows = true }

        let onScreen = cg.filter(\.onScreenPass).map {
            Occluder(id: $0.id, pid: $0.pid, bounds: $0.bounds, layer: $0.layer, alpha: $0.alpha)
        }
        let occluded = isOccluded(id: target.windowID, pid: target.owningApplication?.processID,
                                  bbox: bbox, onScreen: onScreen)
        var meta: [String: Any] = [
            "windowId": Int(target.windowID),
            "title": target.title ?? NSNull(),
            "pid": Int(target.owningApplication?.processID ?? 0),
            "bundleId": target.owningApplication?.bundleIdentifier ?? NSNull(),
            "onScreen": target.isOnScreen,
            "occluded": occluded,
            "matches": matches,
        ]
        if occluded {
            meta["hint"] = "another window covers this window. Raise it (perform AXRaise or activate) before a click."
        }
        return Plan(filter: filter, config: cfg, bbox: bbox, displayIndex: idx,
                    displayId: idx.map { content.displays[$0].displayID }, meta: meta)
    }

    /// One on-screen window for the occluded check (a part of `CGInfo`).
    struct Occluder {
        let id: UInt32
        let pid: Int32
        let bounds: CGRect
        let layer: Int
        let alpha: Double
    }

    /// The highest window layer that counts as covering. Layers 1 to 24 are
    /// floating panels and utility windows. Higher layers (status items, the
    /// cursor) do not count.
    static let maxCoverLayer = 24

    /// Layers in 0...24 that do not count: the Dock and the main menu bar.
    /// A window often sits under them, and a raise does not help.
    static let systemLayers: Set<Int> = [
        Int(CGWindowLevelForKey(.dockWindow)),
        Int(CGWindowLevelForKey(.mainMenuWindow)),
    ]

    /// True when a visible window in front of the target overlaps it.
    /// `onScreen` is the on-screen list in front-to-back order. Counted:
    /// layers 0 to `maxCoverLayer`, except `skipLayers`. Not counted:
    /// windows smaller than `TargetsService.minSide`, invisible windows, and
    /// windows of the same pid inside the target bounds (sheets, popovers,
    /// child windows, which the capture includes). Pure.
    static func isOccluded(id: UInt32, pid: Int32?, bbox: CGRect, onScreen: [Occluder],
                           skipLayers: Set<Int> = systemLayers) -> Bool {
        guard let z = onScreen.firstIndex(where: { $0.id == id }) else { return false }
        return onScreen[..<z].contains { w in
            guard w.layer >= 0, w.layer <= maxCoverLayer, !skipLayers.contains(w.layer),
                  w.alpha > 0 else { return false }
            guard TargetsService.bigEnough(w.bounds) else { return false }
            if let pid, w.pid == pid, bbox.insetBy(dx: -1, dy: -1).contains(w.bounds) { return false }
            return Geometry.overlapArea(w.bounds, bbox) > 0
        }
    }

    @available(macOS 14.0, *)
    static func appPlan(_ req: ShotRequest) throws -> Plan {
        // The Router gives 400 when pid and bundleId are both absent. A safe guard only.
        guard req.pid != nil || req.bundleId != nil else {
            throw fail("app mode needs pid or bundleId", hint: targetsHint)
        }
        let content = try TargetsService.shareableContent(onScreenOnly: true)
        // pid and bundleId together use AND, the same as window mode.
        let app = content.applications.first { a in
            (req.pid.map { a.processID == $0 } ?? true)
                && (req.bundleId.map { a.bundleIdentifier == $0 } ?? true)
        }
        guard let app else {
            throw fail("app has no window on the screen", hint: targetsHint)
        }
        let wins = TargetsService.windows(content: content, onScreenOnly: true).filter {
            $0.pid == app.processID && $0.onScreen && TargetsService.bigEnough($0.bbox)
        }
        guard !wins.isEmpty else { throw fail("app has no window on the screen", hint: targetsHint) }
        let frames = content.displays.map(\.frame)
        let idx: Int
        if let e = try explicitDisplay(req, content) {
            idx = e
        } else if let b = Geometry.bestDisplay(for: wins.map(\.bbox), displays: frames) {
            idx = b
        } else {
            throw fail("app has no window on the screen", hint: targetsHint)
        }
        let parts = wins.compactMap { Geometry.clip($0.bbox, to: frames[idx]) }
        guard let crop = Geometry.union(parts) else {
            throw fail("app has no window on display \(idx)", hint: TargetsService.displayHint(content))
        }
        let d = content.displays[idx]
        let filter = SCContentFilter(display: d, including: [app], exceptingWindows: [])
        if #available(macOS 14.2, *) { filter.includeMenuBar = false }
        let cfg = baseConfig(points: crop.size, scale: pixelScale(filter),
                             maxSize: req.maxSize, cursor: req.cursor ?? false)
        cfg.sourceRect = Geometry.globalToLocal(crop, displayFrame: d.frame)
        let meta: [String: Any] = [
            "pid": Int(app.processID),
            "bundleId": app.bundleIdentifier,
            "windows": parts.count,
        ]
        return Plan(filter: filter, config: cfg, bbox: crop, displayIndex: idx, displayId: d.displayID, meta: meta)
    }

    // MARK: - Output

    @available(macOS 14.0, *)
    static func output(_ image: CGImage, plan: Plan, req: ShotRequest) throws -> [String: Any] {
        guard let data = pngData(image) else { throw fail("encode failed") }
        var out = plan.meta
        out["mode"] = req.mode
        out["bbox"] = Geometry.bboxJSON(plan.bbox)
        out["width"] = image.width
        out["height"] = image.height
        out["scale"] = plan.bbox.width > 0
            ? Geometry.jsonNumber(Geometry.round4(Double(image.width) / Double(plan.bbox.width))) : 1
        out["display"] = plan.displayIndex.map { $0 as Any } ?? NSNull()
        out["displayId"] = plan.displayId.map { Int($0) as Any } ?? NSNull()
        out["bytes"] = data.count
        if req.format == "base64" {
            out["base64"] = data.base64EncodedString()
            return out
        }
        try FileManager.default.createDirectory(atPath: req.outputDir, withIntermediateDirectories: true)
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        let path = (req.outputDir as NSString).appendingPathComponent("shot-\(stamp).png")
        try data.write(to: URL(fileURLWithPath: path))
        out["path"] = path
        if req.defaultDir { Retention.prune(dir: req.outputDir) }
        return out
    }

    @available(macOS 14.0, *)
    private static func captureImageSync(filter: SCContentFilter, config: SCStreamConfiguration) throws -> CGImage {
        try Bridge.wait("the screen capture") { done in
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { cgImage, error in
                done(cgImage, error)
            }
        }
    }

    private static func pngData(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data as CFMutableData, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }
}
