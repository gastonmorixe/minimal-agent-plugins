import ScreenCaptureKit
import CoreGraphics
import Foundation

/// One capture target window: Core Graphics order, layer and bounds, joined
/// with the `SCWindow` of the same window id.
@available(macOS 14.0, *)
struct TargetWindow {
    let id: UInt32
    let pid: Int32
    let bundleId: String?
    let app: String?
    let title: String?
    let bbox: CGRect
    let layer: Int
    let onScreen: Bool
    /// Position in the front-to-back order. 0 is the front window.
    let z: Int
    let sc: SCWindow
}

/// Lists displays and windows for the `targets` route, and resolves window
/// targets for `screenshot`. All geometry is global points, top-left origin.
enum TargetsService {
    /// Windows smaller than this (on either edge, in points) are not targets.
    static let minSide: CGFloat = 20

    static var ownPid: Int32 { ProcessInfo.processInfo.processIdentifier }

    // MARK: - Shareable content

    @available(macOS 14.0, *)
    static func shareableContent(onScreenOnly: Bool) throws -> SCShareableContent {
        try Bridge.wait("the window list") { done in
            SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: onScreenOnly) { content, error in
                done(content, error)
            }
        }
    }

    // MARK: - Core Graphics window list

    struct CGInfo {
        let id: UInt32
        let pid: Int32
        let owner: String?
        let name: String?
        let bounds: CGRect
        let layer: Int
        let onScreen: Bool
        let alpha: Double
        /// True when the entry comes from the on-screen list (the first pass).
        var onScreenPass = true
    }

    /// The Core Graphics window list in front-to-back order. With
    /// `onScreenOnly == false`, the off-screen windows come after the on-screen
    /// windows.
    static func cgWindows(onScreenOnly: Bool) -> [CGInfo] {
        var out: [CGInfo] = []
        var seen = Set<UInt32>()
        func add(_ options: CGWindowListOption, onScreenPass: Bool) {
            guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return }
            for d in list {
                guard let n = d[kCGWindowNumber as String] as? NSNumber else { continue }
                let id = n.uint32Value
                if seen.contains(id) { continue }
                var bounds = CGRect.zero
                if let b = d[kCGWindowBounds as String] as? NSDictionary,
                   let r = CGRect(dictionaryRepresentation: b as CFDictionary) {
                    bounds = r
                }
                seen.insert(id)
                out.append(CGInfo(
                    id: id,
                    pid: (d[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0,
                    owner: d[kCGWindowOwnerName as String] as? String,
                    name: d[kCGWindowName as String] as? String,
                    bounds: bounds,
                    layer: (d[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
                    onScreen: (d[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
                    alpha: (d[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
                    onScreenPass: onScreenPass))
            }
        }
        add([.optionOnScreenOnly, .excludeDesktopElements], onScreenPass: true)
        if !onScreenOnly { add([.optionAll, .excludeDesktopElements], onScreenPass: false) }
        return out
    }

    /// Layer 0 windows of other processes, in front-to-back order, that are
    /// in both lists. No size filter. Pass `cg` to use a Core Graphics list
    /// that the caller already read.
    @available(macOS 14.0, *)
    static func windows(content: SCShareableContent, onScreenOnly: Bool, cg: [CGInfo]? = nil) -> [TargetWindow] {
        var byId: [UInt32: SCWindow] = [:]
        for w in content.windows { byId[w.windowID] = w }
        let me = ownPid
        var out: [TargetWindow] = []
        for (z, c) in (cg ?? cgWindows(onScreenOnly: onScreenOnly)).enumerated() {
            guard c.layer == 0, c.pid != me, let sc = byId[c.id] else { continue }
            let title = sc.title ?? c.name
            out.append(TargetWindow(
                id: c.id, pid: c.pid,
                bundleId: sc.owningApplication?.bundleIdentifier,
                app: sc.owningApplication?.applicationName ?? c.owner,
                title: title, bbox: c.bounds, layer: c.layer,
                onScreen: sc.isOnScreen, z: z, sc: sc))
        }
        return out
    }

    static func bigEnough(_ r: CGRect) -> Bool { r.width >= minSide && r.height >= minSide }

    // MARK: - Displays

    @available(macOS 14.0, *)
    static func displayScale(_ d: SCDisplay) -> Double {
        let s = Double(SCContentFilter(display: d, excludingWindows: []).pointPixelScale)
        return s > 0 ? s : 1
    }

    @available(macOS 14.0, *)
    static func displayEntries(_ content: SCShareableContent) -> [[String: Any]] {
        let main = CGMainDisplayID()
        return content.displays.enumerated().map { i, d in
            [
                "index": i,
                "displayId": Int(d.displayID),
                "bbox": Geometry.bboxJSON(d.frame),
                "scale": Geometry.jsonNumber(Geometry.round4(displayScale(d))),
                "main": d.displayID == main,
            ]
        }
    }

    /// A short text of the displays for an error hint.
    @available(macOS 14.0, *)
    static func displayHint(_ content: SCShareableContent) -> String {
        let parts = content.displays.enumerated().map { i, d -> String in
            let f = d.frame
            return "\(i): id \(d.displayID) [\(Int(f.minX)),\(Int(f.minY)),\(Int(f.width)),\(Int(f.height))]"
        }
        return "displays: " + parts.joined(separator: ", ") + ". Call targets for the full list."
    }

    // MARK: - targets route

    static func targets(pid: Int32?, bundleId: String?, title: String?,
                        visibleOnly: Bool, limit: Int) -> [String: Any] {
        if !Permissions.screenRecordingGranted() {
            return ["error": "screen recording permission not granted",
                    "hint": "Call perms with prompt:true. " + Permissions.grantHint]
        }
        guard #available(macOS 14.0, *) else { return ["error": "targets needs macOS 14 or later"] }
        let content: SCShareableContent
        do { content = try shareableContent(onScreenOnly: visibleOnly) } catch {
            return Bridge.softError("window list failed", error)
        }
        let frames = content.displays.map(\.frame)
        let needle = title?.lowercased()
        var list: [[String: Any]] = []
        var truncated = false
        let cap = max(0, limit)
        for w in windows(content: content, onScreenOnly: visibleOnly) {
            guard bigEnough(w.bbox) else { continue }
            if visibleOnly && !w.onScreen { continue }
            // Stage Manager strips and other parked windows are "on screen" for
            // the window server but sit outside every display. Not visible.
            if visibleOnly && Geometry.largestOverlap(w.bbox, displays: frames) == nil { continue }
            if let pid, w.pid != pid { continue }
            if let bundleId, w.bundleId != bundleId { continue }
            if let needle, !needle.isEmpty, !(w.title ?? "").lowercased().contains(needle) { continue }
            if list.count >= cap {
                truncated = true
                break
            }
            list.append(windowEntry(w, displays: frames))
        }
        return ["displays": displayEntries(content), "windows": list, "truncated": truncated]
    }

    @available(macOS 14.0, *)
    static func windowEntry(_ w: TargetWindow, displays: [CGRect]) -> [String: Any] {
        let disp: Any = Geometry.largestOverlap(w.bbox, displays: displays).map { $0 as Any } ?? NSNull()
        return [
            "windowId": Int(w.id),
            "pid": Int(w.pid),
            "bundleId": w.bundleId ?? NSNull(),
            "app": w.app ?? NSNull(),
            "title": w.title ?? NSNull(),
            "bbox": Geometry.bboxJSON(w.bbox),
            "layer": w.layer,
            "onScreen": w.onScreen,
            "display": disp,
        ]
    }

    // MARK: - AX windows to window id

    /// For each AX window (pid, frame, title), the matching window id when
    /// exactly one window agrees. Never prompts for Screen Recording.
    /// Returns the ids, or an error text.
    static func windowIds(pid: Int32, axWindows: [(frame: CGRect?, title: String?)]) -> (ids: [UInt32?], error: String?) {
        let none = [UInt32?](repeating: nil, count: axWindows.count)
        if !Permissions.screenRecordingGranted() {
            return (none, "screen recording permission not granted: no windowId. Call perms with prompt:true.")
        }
        guard #available(macOS 14.0, *) else { return (none, "windowId needs macOS 14 or later") }
        let content: SCShareableContent
        do { content = try shareableContent(onScreenOnly: false) } catch {
            return (none, "window list failed: \(error.localizedDescription)")
        }
        let keys = windows(content: content, onScreenOnly: false)
            .filter { $0.pid == pid }
            .map { Geometry.WindowKey(id: $0.id, pid: $0.pid, frame: $0.bbox, title: $0.title) }
        let ids: [UInt32?] = axWindows.map { ax -> UInt32? in
            guard let f = ax.frame else { return nil }
            let m = Geometry.matchWindowIds(pid: pid, frame: f, title: ax.title, in: keys)
            return m.count == 1 ? m[0] : nil
        }
        return (ids, nil)
    }
}
