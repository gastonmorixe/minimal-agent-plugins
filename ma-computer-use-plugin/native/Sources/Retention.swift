import Foundation

/// Removes old screenshot files from the default screenshot folder. The
/// helper never calls it for a custom `outputDir`.
enum Retention {
    static let maxAge: TimeInterval = 24 * 60 * 60
    static let keepNewest = 200

    struct Entry {
        let name: String
        let modified: Date
    }

    static func isShotName(_ name: String) -> Bool {
        name.hasPrefix("shot-") && name.hasSuffix(".png")
    }

    /// Pure selection: the names to delete. The newest `keep` shot files always
    /// stay. Of the others, only files older than `maxAge` go.
    static func toDelete(_ entries: [Entry], now: Date,
                         maxAge: TimeInterval = maxAge, keep: Int = keepNewest) -> [String] {
        let shots = entries.filter { isShotName($0.name) }.sorted { $0.modified > $1.modified }
        var out: [String] = []
        for (i, e) in shots.enumerated() where i >= keep && now.timeIntervalSince(e.modified) > maxAge {
            out.append(e.name)
        }
        return out
    }

    /// Apply the selection to a folder. Returns the number of deleted files.
    /// Errors are ignored: a failed delete must not fail a capture.
    /// Only regular files count. A directory or a symlink with a shot name stays.
    @discardableResult
    static func prune(dir: String, now: Date = Date(), keep: Int = keepNewest) -> Int {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir) else { return 0 }
        var entries: [Entry] = []
        for n in names where isShotName(n) {
            let p = (dir as NSString).appendingPathComponent(n)
            guard let attrs = try? fm.attributesOfItem(atPath: p),
                  attrs[.type] as? FileAttributeType == .typeRegular,
                  let m = attrs[.modificationDate] as? Date else { continue }
            entries.append(Entry(name: n, modified: m))
        }
        var deleted = 0
        for n in toDelete(entries, now: now, keep: keep) {
            let p = (dir as NSString).appendingPathComponent(n)
            if (try? fm.removeItem(atPath: p)) != nil { deleted += 1 }
        }
        return deleted
    }
}
