import CoreGraphics
import Foundation

/// Guardrails for an unsandboxed tool that drives the whole machine. Defaults
/// on: kill switch, coordinate bounds clamp, append-only action log, rate limit.
/// Confirm-mode + overlay are out of scope for v0.1 (need a human present).
final class Safety {
    static let shared = Safety()

    private let lock = NSLock()
    private var recentActionTimes: [Date] = []
    private let rateLimit = 20  // mutating actions per second
    private let actionLogPath: String
    private let disabledFlagPath: String

    init() {
        let logsDir = (NSHomeDirectory() as NSString)
            .appendingPathComponent("Library/Logs/ma-computer-use")
        actionLogPath = ProcessInfo.processInfo.environment["CUD_ACTION_LOG"]
            ?? (logsDir as NSString).appendingPathComponent("actions.log")
        let supportDir = (NSHomeDirectory() as NSString)
            .appendingPathComponent("Library/Application Support/ma-computer-use")
        disabledFlagPath = ProcessInfo.processInfo.environment["CUD_DISABLED_FLAG"]
            ?? (supportDir as NSString).appendingPathComponent("disabled")
    }

    /// True when mutating actions are globally disabled (env or flag file).
    var disabled: Bool {
        if ProcessInfo.processInfo.environment["CUD_DISABLED"] == "1" { return true }
        return FileManager.default.fileExists(atPath: disabledFlagPath)
    }

    /// Routes that mutate state (input + AX writes). Reads are always allowed.
    static let mutatingRoutes: Set<String> = [
        "perform", "setValue", "mouse", "type", "key", "keypress",
    ]

    /// Gate a mutating action. Returns nil if allowed, or an error dict if blocked.
    func gate(route: String) -> [String: Any]? {
        guard Safety.mutatingRoutes.contains(route) else { return nil }
        if disabled {
            return ["error": "computer-use is disabled (kill switch active). Run: cud enable"]
        }
        // Rate limit.
        lock.lock()
        let now = Date()
        recentActionTimes = recentActionTimes.filter { now.timeIntervalSince($0) < 1.0 }
        if recentActionTimes.count >= rateLimit {
            lock.unlock()
            return ["error": "rate limit exceeded (\(rateLimit)/s)"]
        }
        recentActionTimes.append(now)
        lock.unlock()
        return nil
    }

    /// Clamp a point to the union of display bounds so we never click off-screen.
    func clamp(_ p: CGPoint) -> CGPoint {
        let b = unionDisplayBounds()
        let x = min(max(p.x, b.minX), b.maxX - 1)
        let y = min(max(p.y, b.minY), b.maxY - 1)
        return CGPoint(x: x, y: y)
    }

    /// Append a JSONL audit record. Typed text is redacted by default.
    func log(route: String, body: [String: Any], status: Int) {
        var record: [String: Any] = [
            "ts": ISO8601DateFormatter().string(from: Date()),
            "route": route,
            "status": status,
        ]
        var safeBody = body
        if route == "type", safeBody["text"] != nil {
            let len = (safeBody["text"] as? String)?.count ?? 0
            safeBody["text"] = "<redacted \(len) chars>"
        }
        record["body"] = safeBody
        guard let data = try? JSONSerialization.data(withJSONObject: record) else { return }
        let line = data + Data("\n".utf8)
        let dir = (actionLogPath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        if let fh = FileHandle(forWritingAtPath: actionLogPath) {
            fh.seekToEndOfFile()
            fh.write(line)
            try? fh.close()
        } else {
            try? line.write(to: URL(fileURLWithPath: actionLogPath))
        }
    }
}
