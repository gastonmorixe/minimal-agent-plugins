import ApplicationServices
import CoreGraphics
import AppKit
import Foundation

/// TCC permission checks + prompts for the three services a computer-use helper
/// touches: Accessibility (read AX + post events), Screen Recording (screenshots),
/// Input Monitoring (only if we ever read the live event stream; optional here).
///
/// The prompts MUST originate from this signed .app so TCC attributes the grant
/// to ComputerUseHelper.app (not bun). The grant then persists across rebuilds
/// because it keys on the stable designated requirement.
enum Permissions {
    static func accessibilityTrusted(prompt: Bool) -> Bool {
        if prompt {
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            let opts = [key: true] as CFDictionary
            return AXIsProcessTrustedWithOptions(opts)
        }
        return AXIsProcessTrusted()
    }

    static func screenRecordingGranted() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    @discardableResult
    static func requestScreenRecording() -> Bool {
        CGRequestScreenCaptureAccess()
    }

    static func inputMonitoringGranted() -> Bool {
        CGPreflightListenEventAccess()
    }

    @discardableResult
    static func requestInputMonitoring() -> Bool {
        CGRequestListenEventAccess()
    }

    /// Status snapshot of all three.
    static func status() -> [String: Any] {
        [
            "ax": accessibilityTrusted(prompt: false),
            "screen": screenRecordingGranted(),
            "input": inputMonitoringGranted(),
        ]
    }

    /// Open the right System Settings privacy pane.
    static func openSettings(_ pane: String) {
        let anchor: String
        switch pane {
        case "ax", "accessibility": anchor = "Privacy_Accessibility"
        case "screen", "screencapture": anchor = "Privacy_ScreenCapture"
        case "input", "listenevent": anchor = "Privacy_ListenEvent"
        default: anchor = "Privacy_Accessibility"
        }
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Handle the `perms` route. With prompt:true, fires native prompts for any
    /// missing permission and opens the relevant Settings pane.
    static func handle(prompt: Bool, pane: String?) -> [String: Any] {
        var result = status()
        if prompt {
            var instructions: [String] = []
            if !(result["ax"] as? Bool ?? false) {
                _ = accessibilityTrusted(prompt: true)
                openSettings("ax")
                instructions.append(
                    "Enable ComputerUseHelper under System Settings → Privacy & Security → Accessibility.")
            }
            if !(result["screen"] as? Bool ?? false) {
                requestScreenRecording()
                openSettings("screen")
                instructions.append(
                    "Enable ComputerUseHelper under System Settings → Privacy & Security → Screen & System Audio Recording.")
            }
            if let pane, pane == "input", !(result["input"] as? Bool ?? false) {
                requestInputMonitoring()
                openSettings("input")
                instructions.append(
                    "Enable ComputerUseHelper under System Settings → Privacy & Security → Input Monitoring.")
            }
            // Re-read after prompting (state may not flip until relaunch).
            result = status()
            if !instructions.isEmpty {
                result["instructions"] = instructions
                result["note"] =
                    "After enabling, the helper may need a restart (run: cud restart) for the grant to take effect."
            }
        }
        return result
    }
}
