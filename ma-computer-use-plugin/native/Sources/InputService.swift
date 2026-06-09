import CoreGraphics
import AppKit
import Carbon.HIToolbox
import Foundation

/// Low-level mouse + keyboard synthesis via Quartz Event Services (CGEvent).
/// This is the "last resort" surface: prefer AX actions when available. All
/// coordinates are logical points in CG top-left global space (same as AX).
enum InputService {
    private static func source() -> CGEventSource? {
        CGEventSource(stateID: .hidSystemState)
    }

    private static let tap: CGEventTapLocation = .cghidEventTap

    // MARK: - Mouse

    static func move(to p: CGPoint) {
        let e = CGEvent(mouseEventSource: source(), mouseType: .mouseMoved,
                        mouseCursorPosition: p, mouseButton: .left)
        e?.post(tap: tap)
    }

    static func click(at p: CGPoint, button: CGMouseButton, clicks: Int) {
        let (downType, upType): (CGEventType, CGEventType)
        switch button {
        case .right: (downType, upType) = (.rightMouseDown, .rightMouseUp)
        case .center: (downType, upType) = (.otherMouseDown, .otherMouseUp)
        default: (downType, upType) = (.leftMouseDown, .leftMouseUp)
        }
        let down = CGEvent(mouseEventSource: source(), mouseType: downType,
                           mouseCursorPosition: p, mouseButton: button)
        let up = CGEvent(mouseEventSource: source(), mouseType: upType,
                         mouseCursorPosition: p, mouseButton: button)
        for state in 1...max(1, clicks) {
            down?.setIntegerValueField(.mouseEventClickState, value: Int64(state))
            down?.post(tap: tap)
            up?.setIntegerValueField(.mouseEventClickState, value: Int64(state))
            up?.post(tap: tap)
            usleep(20_000)
        }
    }

    static func mouseDown(at p: CGPoint, button: CGMouseButton) {
        let t: CGEventType = button == .right ? .rightMouseDown
            : (button == .center ? .otherMouseDown : .leftMouseDown)
        CGEvent(mouseEventSource: source(), mouseType: t,
                mouseCursorPosition: p, mouseButton: button)?.post(tap: tap)
    }

    static func mouseUp(at p: CGPoint, button: CGMouseButton) {
        let t: CGEventType = button == .right ? .rightMouseUp
            : (button == .center ? .otherMouseUp : .leftMouseUp)
        CGEvent(mouseEventSource: source(), mouseType: t,
                mouseCursorPosition: p, mouseButton: button)?.post(tap: tap)
    }

    static func drag(from a: CGPoint, to b: CGPoint, button: CGMouseButton, steps: Int) {
        let downType: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
        let dragType: CGEventType = button == .right ? .rightMouseDragged : .leftMouseDragged
        let upType: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
        CGEvent(mouseEventSource: source(), mouseType: downType,
                mouseCursorPosition: a, mouseButton: button)?.post(tap: tap)
        usleep(10_000)
        let n = max(1, steps)
        for i in 1...n {
            let t = CGFloat(i) / CGFloat(n)
            let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
            CGEvent(mouseEventSource: source(), mouseType: dragType,
                    mouseCursorPosition: p, mouseButton: button)?.post(tap: tap)
            usleep(8_000)
        }
        CGEvent(mouseEventSource: source(), mouseType: upType,
                mouseCursorPosition: b, mouseButton: button)?.post(tap: tap)
    }

    static func scroll(dyLines: Int32, dxLines: Int32, at p: CGPoint?) {
        if let p { move(to: p); usleep(5_000) }
        let e = CGEvent(scrollWheelEvent2Source: source(), units: .line,
                        wheelCount: dxLines == 0 ? 1 : 2,
                        wheel1: dyLines, wheel2: dxLines, wheel3: 0)
        e?.post(tap: tap)
    }

    // MARK: - Keyboard

    static func typeString(_ string: String) {
        let src = source()
        for ch in string {
            let utf16 = Array(String(ch).utf16)
            let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
            down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            down?.post(tap: tap)
            let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
            up?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            up?.post(tap: tap)
            usleep(2_000)
        }
    }

    static func keyPress(code: CGKeyCode, flags: CGEventFlags, holdMs: Int) {
        let src = source()
        let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
        let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
        down?.flags = flags
        up?.flags = flags
        down?.post(tap: tap)
        if holdMs > 0 { usleep(useconds_t(min(holdMs, 5000) * 1000)) }
        up?.post(tap: tap)
    }

    // MARK: - Secure input guard

    static func secureInputActive() -> Bool {
        IsSecureEventInputEnabled()
    }
}
