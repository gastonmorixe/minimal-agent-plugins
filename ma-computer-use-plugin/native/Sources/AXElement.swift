import ApplicationServices
import AppKit

/// Swift conveniences over the AXUIElement C API. Patterns lifted from the
/// research doc (01-accessibility-api.md), cross-checked against AXSwift.
extension AXUIElement {
    /// Generic typed attribute read. nil for missing/unsupported.
    func value<T>(_ attribute: String) -> T? {
        var ref: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(self, attribute as CFString, &ref)
        guard err == .success, let ref else { return nil }
        return ref as? T
    }

    /// Raw read returning the AXError + optional ref (for liveness checks).
    func rawRead(_ attribute: String) -> (AXError, CFTypeRef?) {
        var ref: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(self, attribute as CFString, &ref)
        return (err, ref)
    }

    func attributeNames() -> [String] {
        var names: CFArray?
        let err = AXUIElementCopyAttributeNames(self, &names)
        guard err == .success, let arr = names as? [String] else { return [] }
        return arr
    }

    func actionNames() -> [String] {
        var names: CFArray?
        let err = AXUIElementCopyActionNames(self, &names)
        guard err == .success, let arr = names as? [String] else { return [] }
        return arr
    }

    @discardableResult
    func perform(_ action: String) -> AXError {
        AXUIElementPerformAction(self, action as CFString)
    }

    func isSettable(_ attribute: String) -> Bool {
        var settable: DarwinBoolean = false
        let err = AXUIElementIsAttributeSettable(self, attribute as CFString, &settable)
        return err == .success && settable.boolValue
    }

    @discardableResult
    func set(_ attribute: String, _ value: CFTypeRef) -> AXError {
        AXUIElementSetAttributeValue(self, attribute as CFString, value)
    }

    var pid: pid_t? {
        var p: pid_t = 0
        return AXUIElementGetPid(self, &p) == .success ? p : nil
    }

    // Typed getters
    var role: String? { value(kAXRoleAttribute as String) }
    var subrole: String? { value(kAXSubroleAttribute as String) }
    var title: String? { value(kAXTitleAttribute as String) }
    var roleDescription: String? { value(kAXRoleDescriptionAttribute as String) }
    var help: String? { value(kAXHelpAttribute as String) }
    var axDescription: String? { value(kAXDescriptionAttribute as String) }
    var identifier: String? { value(kAXIdentifierAttribute as String) }
    var isEnabled: Bool { (value(kAXEnabledAttribute as String) as Bool?) ?? true }
    var isFocused: Bool { (value(kAXFocusedAttribute as String) as Bool?) ?? false }
    var children: [AXUIElement] { value(kAXChildrenAttribute as String) ?? [] }
    var windows: [AXUIElement] { value(kAXWindowsAttribute as String) ?? [] }
    var parent: AXUIElement? { value(kAXParentAttribute as String) }

    /// Stringified kAXValueAttribute (text content / slider value / etc).
    var valueString: String? {
        guard let v: CFTypeRef = value(kAXValueAttribute as String) else { return nil }
        if let s = v as? String { return s }
        if CFGetTypeID(v) == AXValueGetTypeID() { return nil }  // geometry, not text
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }

    var position: CGPoint? {
        guard let v: CFTypeRef = value(kAXPositionAttribute as String),
              CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        let axv = v as! AXValue
        var p = CGPoint.zero
        return AXValueGetValue(axv, .cgPoint, &p) ? p : nil
    }

    var size: CGSize? {
        guard let v: CFTypeRef = value(kAXSizeAttribute as String),
              CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        let axv = v as! AXValue
        var s = CGSize.zero
        return AXValueGetValue(axv, .cgSize, &s) ? s : nil
    }

    var frame: CGRect? {
        guard let p = position, let s = size else { return nil }
        return CGRect(origin: p, size: s)
    }

    /// Cheap liveness probe. Returns false if the ref is dead/stale.
    func isAlive() -> Bool {
        let (err, _) = rawRead(kAXRoleAttribute as String)
        switch err {
        case .success, .noValue, .attributeUnsupported:
            return true
        case .invalidUIElement, .cannotComplete, .notImplemented:
            return false
        default:
            return true
        }
    }
}

/// Bridge AXError to a stable string for responses.
func axErrorName(_ e: AXError) -> String {
    switch e {
    case .success: return "success"
    case .failure: return "failure"
    case .illegalArgument: return "illegalArgument"
    case .invalidUIElement: return "invalidUIElement"
    case .invalidUIElementObserver: return "invalidUIElementObserver"
    case .cannotComplete: return "cannotComplete"
    case .attributeUnsupported: return "attributeUnsupported"
    case .actionUnsupported: return "actionUnsupported"
    case .notificationUnsupported: return "notificationUnsupported"
    case .notImplemented: return "notImplemented"
    case .notificationAlreadyRegistered: return "notificationAlreadyRegistered"
    case .notificationNotRegistered: return "notificationNotRegistered"
    case .apiDisabled: return "apiDisabled"
    case .noValue: return "noValue"
    case .parameterizedAttributeUnsupported: return "parameterizedAttributeUnsupported"
    case .notEnoughPrecision: return "notEnoughPrecision"
    @unknown default: return "unknown(\(e.rawValue))"
    }
}
