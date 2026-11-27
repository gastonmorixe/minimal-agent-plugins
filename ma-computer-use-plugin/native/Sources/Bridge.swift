import Foundation

/// Bridges a completion-handler API to a synchronous call with a timeout.
///
/// The daemon runs all requests on one serial queue. A callback that never
/// comes must not stop that queue, so each wait has a time limit. The result
/// goes into a lock-protected box: a callback that comes after the timeout
/// writes into the box and nothing reads it, which is safe.
enum Bridge {
    /// The default time limit for one ScreenCaptureKit call.
    static let defaultTimeout: TimeInterval = 10

    enum BridgeError: LocalizedError {
        case timeout(what: String, seconds: Double)
        case noResult(what: String)

        var errorDescription: String? {
            switch self {
            case let .timeout(what, seconds):
                return "\(what) did not answer in \(Geometry.jsonNumber(seconds)) s (timeout)"
            case let .noResult(what):
                return "\(what) gave no result"
            }
        }
    }

    static let timeoutHint = "ScreenCaptureKit did not answer. Try again in some seconds."

    private final class Box<T> {
        let lock = NSLock()
        var value: T?
        var error: Error?
        var done = false
    }

    /// Calls `start` with a completion handler and waits for it, at most
    /// `timeout` seconds. Throws `BridgeError.timeout` when the handler does
    /// not come in time, the error of the handler, or `BridgeError.noResult`.
    static func wait<T>(_ what: String, timeout: TimeInterval = defaultTimeout,
                        _ start: (@escaping (T?, Error?) -> Void) -> Void) throws -> T {
        let sem = DispatchSemaphore(value: 0)
        let box = Box<T>()
        start { value, error in
            box.lock.lock()
            if !box.done {
                box.value = value
                box.error = error
                box.done = true
            }
            box.lock.unlock()
            sem.signal()
        }
        guard sem.wait(timeout: .now() + timeout) == .success else {
            throw BridgeError.timeout(what: what, seconds: timeout)
        }
        box.lock.lock()
        let value = box.value
        let error = box.error
        box.lock.unlock()
        if let error { throw error }
        guard let value else { throw BridgeError.noResult(what: what) }
        return value
    }

    static func isTimeout(_ error: Error) -> Bool {
        if case BridgeError.timeout = error { return true }
        return false
    }

    /// A soft-error body (`error` and, for a timeout, `hint`) for a route.
    static func softError(_ prefix: String, _ error: Error) -> [String: Any] {
        var d: [String: Any] = ["error": "\(prefix): \(error.localizedDescription)"]
        if isTimeout(error) { d["hint"] = timeoutHint }
        return d
    }
}
