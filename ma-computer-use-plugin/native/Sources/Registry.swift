import ApplicationServices
import Foundation

/// In-memory map of short string handles ("e0","e1",...) to live AXUIElement
/// refs. AXUIElement refs are opaque + process-local + non-serializable, so the
/// daemon must hold them for the agent to address an element across calls.
///
/// Handles are globally unique within the daemon process. A bounded capacity
/// evicts the oldest entries so the registry can't grow without limit across
/// many snapshots.
final class Registry {
    static let shared = Registry()

    private var map: [String: AXUIElement] = [:]
    private var order: [String] = []  // insertion order for LRU-ish eviction
    private var counter = 0
    private var snapshotCounter = 0
    private let capacity = 8000
    private let lock = NSLock()

    /// Mint a new handle for an element.
    func put(_ element: AXUIElement) -> String {
        lock.lock(); defer { lock.unlock() }
        let handle = "e\(counter)"
        counter += 1
        map[handle] = element
        order.append(handle)
        evictIfNeeded()
        return handle
    }

    func get(_ handle: String) -> AXUIElement? {
        lock.lock(); defer { lock.unlock() }
        return map[handle]
    }

    /// Allocate a fresh snapshot id (s1, s2, ...).
    func newSnapshotId() -> String {
        lock.lock(); defer { lock.unlock() }
        snapshotCounter += 1
        return "s\(snapshotCounter)"
    }

    private func evictIfNeeded() {
        while order.count > capacity {
            let old = order.removeFirst()
            map.removeValue(forKey: old)
        }
    }
}
