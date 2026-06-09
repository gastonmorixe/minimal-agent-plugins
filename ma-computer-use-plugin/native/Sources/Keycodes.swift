import CoreGraphics

/// Maps human key names to ANSI virtual keycodes (Carbon Events.h positions) and
/// modifier names to CGEventFlags. Used by the `key` / `keypress` routes so the
/// agent can say "cmd+shift+4" or {key:"return", modifiers:["cmd"]}.
enum Keycodes {
    static let map: [String: CGKeyCode] = [
        // letters
        "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05,
        "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C,
        "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11, "o": 0x1F,
        "u": 0x20, "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26, "k": 0x28,
        "n": 0x2D, "m": 0x2E,
        // digits
        "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "5": 0x17, "6": 0x16,
        "7": 0x1A, "8": 0x1C, "9": 0x19, "0": 0x1D,
        // punctuation
        "=": 0x18, "-": 0x1B, "]": 0x1E, "[": 0x21, "'": 0x27, ";": 0x29,
        "\\": 0x2A, ",": 0x2B, "/": 0x2C, ".": 0x2F, "`": 0x32,
        // whitespace / editing / control
        "return": 0x24, "enter": 0x24, "tab": 0x30, "space": 0x31,
        "delete": 0x33, "backspace": 0x33, "escape": 0x35, "esc": 0x35,
        "forwarddelete": 0x75, "fdelete": 0x75, "help": 0x72,
        "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
        // arrows
        "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
        // function keys
        "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61,
        "f7": 0x62, "f8": 0x64, "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
        "f13": 0x69, "f14": 0x6B, "f15": 0x71, "f16": 0x6A, "f17": 0x40,
        "f18": 0x4F, "f19": 0x50, "f20": 0x5A,
        // keypad
        "kp0": 0x52, "kp1": 0x53, "kp2": 0x54, "kp3": 0x55, "kp4": 0x56,
        "kp5": 0x57, "kp6": 0x58, "kp7": 0x59, "kp8": 0x5B, "kp9": 0x5C,
        "kpdecimal": 0x41, "kpmultiply": 0x43, "kpplus": 0x45, "kpminus": 0x4E,
        "kpdivide": 0x4B, "kpenter": 0x4C, "kpequals": 0x51, "kpclear": 0x47,
    ]

    static func keycode(for name: String) -> CGKeyCode? {
        map[name.lowercased()]
    }

    static func modifier(for name: String) -> CGEventFlags? {
        switch name.lowercased() {
        case "cmd", "command", "meta", "super": return .maskCommand
        case "shift": return .maskShift
        case "alt", "option", "opt": return .maskAlternate
        case "ctrl", "control": return .maskControl
        case "fn", "function": return .maskSecondaryFn
        case "caps", "capslock": return .maskAlphaShift
        default: return nil
        }
    }

    /// Parse "cmd+shift+4" → (keycode, flags). Returns nil if the final token
    /// isn't a known key.
    static func parseCombo(_ combo: String) -> (CGKeyCode, CGEventFlags)? {
        let tokens = combo.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
        guard !tokens.isEmpty else { return nil }
        var flags: CGEventFlags = []
        var keyToken: String?
        for t in tokens {
            if let m = modifier(for: t) { flags.insert(m) }
            else { keyToken = t }
        }
        guard let k = keyToken, let code = keycode(for: k) else { return nil }
        return (code, flags)
    }
}
