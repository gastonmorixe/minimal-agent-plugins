import ApplicationServices
import AppKit
import Foundation

/// Accessibility inspection + interaction. The AX-first surface: snapshot the
/// tree, find elements, read/write values, perform AX actions. Everything keys
/// off the shared Registry for stable handles.
enum AXService {
    /// Default per-element messaging timeout so a wedged target can't hang us.
    static let messagingTimeout: Float = 2.0

    // MARK: - App / window enumeration

    static func apps() -> [[String: Any]] {
        let running = NSWorkspace.shared.runningApplications
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        var out: [[String: Any]] = []
        for app in running where app.activationPolicy == .regular {
            out.append([
                "pid": Int(app.processIdentifier),
                "bundleId": app.bundleIdentifier ?? NSNull(),
                "name": app.localizedName ?? NSNull(),
                "frontmost": app.processIdentifier == front,
            ])
        }
        return out
    }

    /// Bring an app to the foreground so subsequent keyboard input lands in it.
    /// Returns true if a matching running app was found and asked to activate.
    @discardableResult
    static func activate(pid: pid_t?, bundleId: String?) -> Bool {
        let target: NSRunningApplication?
        if let pid { target = NSRunningApplication(processIdentifier: pid) }
        else if let bundleId {
            target = NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == bundleId }
        } else {
            target = nil
        }
        guard let app = target else { return false }
        app.activate(options: [.activateAllWindows])
        return true
    }

    static func appInfo(_ app: NSRunningApplication) -> [String: Any] {
        [
            "pid": Int(app.processIdentifier),
            "bundleId": app.bundleIdentifier ?? NSNull(),
            "name": app.localizedName ?? NSNull(),
        ]
    }

    static func appElement(pid: pid_t?, bundleId: String?) -> (AXUIElement, NSRunningApplication)? {
        let target: NSRunningApplication?
        if let pid { target = NSRunningApplication(processIdentifier: pid) }
        else if let bundleId {
            target = NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == bundleId }
        } else {
            target = NSWorkspace.shared.frontmostApplication
        }
        guard let app = target else { return nil }
        let el = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(el, messagingTimeout)
        return (el, app)
    }

    static func windows(pid: pid_t?, bundleId: String?) -> [String: Any] {
        guard let (appEl, app) = appElement(pid: pid, bundleId: bundleId) else {
            return ["error": "app not found"]
        }
        _ = appEl.role  // wake the tree
        var wins: [[String: Any]] = []
        for w in appEl.windows {
            let handle = Registry.shared.put(w)
            var entry: [String: Any] = [
                "el": handle,
                "title": w.title ?? NSNull(),
                "subrole": w.subrole ?? NSNull(),
            ]
            if let f = w.frame { entry["bbox"] = [f.origin.x, f.origin.y, f.size.width, f.size.height] }
            if let minimized: Bool = w.value(kAXMinimizedAttribute as String) {
                entry["minimized"] = minimized
            }
            wins.append(entry)
        }
        return [
            "app": appInfo(app),
            "windows": wins,
        ]
    }

    // MARK: - Snapshot

    struct SnapshotOptions {
        var maxDepth = 20
        var maxNodes = 2000
        var visibleOnly = true
        var flatten = true
    }

    static func snapshot(pid: pid_t?, bundleId: String?, options: SnapshotOptions) -> [String: Any] {
        guard let (appEl, app) = appElement(pid: pid, bundleId: bundleId) else {
            return ["error": "app not found"]
        }
        _ = appEl.role  // wake the tree
        let snapshotId = Registry.shared.newSnapshotId()
        var nodeCount = 0
        var truncated = false
        let screenBounds = unionDisplayBounds()

        // Flattened collector
        var flat: [[String: Any]] = []

        func visible(_ el: AXUIElement) -> Bool {
            guard options.visibleOnly else { return true }
            guard let f = el.frame else { return true }  // unknown frame: keep
            if f.size.width <= 0 || f.size.height <= 0 { return false }
            return f.intersects(screenBounds)
        }

        func emit(_ el: AXUIElement, depth: Int) -> [String: Any]? {
            if nodeCount >= options.maxNodes { truncated = true; return nil }
            if options.visibleOnly && depth > 0 && !visible(el) { return nil }
            nodeCount += 1
            let handle = Registry.shared.put(el)
            var node: [String: Any] = ["el": handle]
            if let r = el.role { node["role"] = r }
            if let sr = el.subrole { node["subrole"] = sr }
            if let t = el.title, !t.isEmpty { node["title"] = t }
            if let v = el.valueString, !v.isEmpty { node["value"] = clip(v, 500) }
            if let d = el.axDescription, !d.isEmpty { node["desc"] = clip(d, 200) }
            if let id = el.identifier, !id.isEmpty { node["id"] = id }
            node["enabled"] = el.isEnabled
            if let f = el.frame {
                node["bbox"] = [round2(f.origin.x), round2(f.origin.y),
                                round2(f.size.width), round2(f.size.height)]
            }
            let acts = el.actionNames()
            if !acts.isEmpty { node["actions"] = acts }

            if depth < options.maxDepth {
                var childNodes: [[String: Any]] = []
                for c in el.children {
                    if nodeCount >= options.maxNodes { truncated = true; break }
                    if let child = emit(c, depth: depth + 1) {
                        if !options.flatten { childNodes.append(child) }
                    }
                }
                if !options.flatten && !childNodes.isEmpty { node["children"] = childNodes }
            } else if !el.children.isEmpty {
                node["truncated"] = true
            }
            if options.flatten { flat.append(node) }
            return node
        }

        let root = emit(appEl, depth: 0)

        var result: [String: Any] = [
            "snapshotId": snapshotId,
            "app": appInfo(app),
            "truncated": truncated,
            "nodeCount": nodeCount,
        ]
        if options.flatten {
            result["elements"] = flat
        } else {
            result["tree"] = root ?? NSNull()
        }
        return result
    }

    // MARK: - Find

    static func find(role: String?, title: String?, identifier: String?,
                     valueContains: String?, pid: pid_t?, bundleId: String?,
                     limit: Int) -> [String: Any] {
        guard let (appEl, _) = appElement(pid: pid, bundleId: bundleId) else {
            return ["error": "app not found"]
        }
        _ = appEl.role
        var matches: [[String: Any]] = []
        var visited = 0
        let maxVisit = 6000

        func walk(_ el: AXUIElement, depth: Int) {
            if matches.count >= limit || visited >= maxVisit || depth > 40 { return }
            visited += 1
            var ok = true
            if let role { ok = ok && (el.role == role) }
            if let title { ok = ok && (el.title?.localizedCaseInsensitiveContains(title) ?? false) }
            if let identifier { ok = ok && (el.identifier == identifier) }
            if let valueContains {
                ok = ok && (el.valueString?.localizedCaseInsensitiveContains(valueContains) ?? false)
            }
            if ok {
                let handle = Registry.shared.put(el)
                var m: [String: Any] = ["el": handle]
                if let r = el.role { m["role"] = r }
                if let t = el.title { m["title"] = t }
                if let v = el.valueString { m["value"] = clip(v, 300) }
                if let f = el.frame {
                    m["bbox"] = [round2(f.origin.x), round2(f.origin.y),
                                 round2(f.size.width), round2(f.size.height)]
                }
                let acts = el.actionNames()
                if !acts.isEmpty { m["actions"] = acts }
                matches.append(m)
            }
            for c in el.children { walk(c, depth: depth + 1) }
        }
        walk(appEl, depth: 0)
        return ["matches": matches, "count": matches.count]
    }

    // MARK: - Hit test / focused

    static func elementAtPoint(x: CGFloat, y: CGFloat) -> [String: Any] {
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, messagingTimeout)
        var out: AXUIElement?
        let err = AXUIElementCopyElementAtPosition(sys, Float(x), Float(y), &out)
        guard err == .success, let el = out else {
            return ["error": "no element at point", "axError": axErrorName(err)]
        }
        return ["element": describeElement(el, includeAttributes: false)]
    }

    static func focused() -> [String: Any] {
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, messagingTimeout)
        guard let el: AXUIElement = sys.value(kAXFocusedUIElementAttribute as String) else {
            return ["error": "no focused element"]
        }
        return ["element": describeElement(el, includeAttributes: true)]
    }

    // MARK: - Describe / get / set / perform

    static func describe(handle: String) -> [String: Any] {
        guard let el = liveElement(handle) else { return staleError(handle) }
        return ["element": describeElement(el, includeAttributes: true)]
    }

    static func getValue(handle: String) -> [String: Any] {
        guard let el = liveElement(handle) else { return staleError(handle) }
        if let v = el.valueString { return ["value": v] }
        if let v: CFTypeRef = el.value(kAXValueAttribute as String) {
            return ["value": String(describing: v)]
        }
        return ["value": NSNull()]
    }

    static func setValue(handle: String, value: Any) -> [String: Any] {
        guard let el = liveElement(handle) else { return staleError(handle) }
        let attr = kAXValueAttribute as String
        guard el.isSettable(attr) else {
            return ["error": "value not settable on this element"]
        }
        let cfValue: CFTypeRef
        if let s = value as? String { cfValue = s as CFString }
        else if let n = value as? NSNumber { cfValue = n }
        else { cfValue = String(describing: value) as CFString }
        let err = el.set(attr, cfValue)
        if err == .success { return ["ok": true] }
        return ["error": "setValue failed", "axError": axErrorName(err)]
    }

    static func perform(handle: String, action: String) -> [String: Any] {
        guard let el = liveElement(handle) else { return staleError(handle) }
        let available = el.actionNames()
        guard available.contains(action) else {
            return ["error": "action not supported", "available": available]
        }
        let err = el.perform(action)
        // cannotComplete can mean "app slow"; treat success/cannotComplete leniently.
        if err == .success { return ["ok": true] }
        if err == .cannotComplete {
            return ["ok": true, "warning": "cannotComplete (app may be slow); action likely dispatched"]
        }
        return ["error": "perform failed", "axError": axErrorName(err)]
    }

    // MARK: - Helpers

    /// Resolve a handle to a live element, or nil if stale/dead.
    static func liveElement(_ handle: String) -> AXUIElement? {
        guard let el = Registry.shared.get(handle) else { return nil }
        return el.isAlive() ? el : nil
    }

    static func staleError(_ handle: String) -> [String: Any] {
        ["error": "stale or unknown handle \(handle); re-snapshot", "stale": true]
    }

    static func describeElement(_ el: AXUIElement, includeAttributes: Bool) -> [String: Any] {
        let handle = Registry.shared.put(el)
        var d: [String: Any] = ["el": handle]
        if let r = el.role { d["role"] = r }
        if let sr = el.subrole { d["subrole"] = sr }
        if let t = el.title { d["title"] = t }
        if let rd = el.roleDescription { d["roleDescription"] = rd }
        if let v = el.valueString { d["value"] = clip(v, 1000) }
        if let desc = el.axDescription { d["desc"] = desc }
        if let id = el.identifier { d["id"] = id }
        if let h = el.help { d["help"] = h }
        d["enabled"] = el.isEnabled
        d["focused"] = el.isFocused
        if let f = el.frame {
            d["bbox"] = [round2(f.origin.x), round2(f.origin.y),
                         round2(f.size.width), round2(f.size.height)]
        }
        d["actions"] = el.actionNames()
        if includeAttributes { d["attributes"] = el.attributeNames() }
        if let p = el.pid { d["pid"] = Int(p) }
        return d
    }
}

// MARK: - Free helpers

func clip(_ s: String, _ n: Int) -> String {
    if s.count <= n { return s }
    return String(s.prefix(n)) + "…"
}

func round2(_ v: CGFloat) -> Double { (Double(v) * 100).rounded() / 100 }

/// Union of all active display bounds in CG top-left global coords.
func unionDisplayBounds() -> CGRect {
    let maxDisplays = 16
    var ids = [CGDirectDisplayID](repeating: 0, count: maxDisplays)
    var count: UInt32 = 0
    CGGetActiveDisplayList(UInt32(maxDisplays), &ids, &count)
    var rect = CGRect.null
    for i in 0..<Int(count) {
        rect = rect.union(CGDisplayBounds(ids[i]))
    }
    return rect.isNull ? CGRect(x: 0, y: 0, width: 100000, height: 100000) : rect
}
