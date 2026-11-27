import CoreGraphics
import Foundation

/// Offline checks of the pure geometry and retention functions. Run with
/// `ComputerUseHelper --selftest`. Exit 0 when all checks pass, else 1.
enum SelfTest {
    private static var passed = 0
    private static var failed: [String] = []

    private static func check(_ ok: Bool, _ name: String) {
        if ok { passed += 1 } else { failed.append(name) }
    }

    private static func near(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a - b) < 0.0001 }

    private static func eq(_ a: CGRect?, _ b: CGRect?) -> Bool {
        guard let a, let b else { return a == nil && b == nil }
        return near(a.minX, b.minX) && near(a.minY, b.minY) && near(a.width, b.width) && near(a.height, b.height)
    }

    static func run() -> Int32 {
        // Two displays: main 1512x982 at 0,0 and an external 1920x1080 to the right,
        // plus one display above the main one with a negative y.
        let main = CGRect(x: 0, y: 0, width: 1512, height: 982)
        let right = CGRect(x: 1512, y: -100, width: 1920, height: 1080)
        let above = CGRect(x: 0, y: -1080, width: 1512, height: 1080)
        let displays = [main, right, above]

        // globalToLocal
        check(eq(Geometry.globalToLocal(CGRect(x: 1600, y: 0, width: 100, height: 50), displayFrame: right),
                 CGRect(x: 88, y: 100, width: 100, height: 50)), "globalToLocal right display")
        check(eq(Geometry.globalToLocal(CGRect(x: 10, y: -1000, width: 5, height: 5), displayFrame: above),
                 CGRect(x: 10, y: 80, width: 5, height: 5)), "globalToLocal negative y")
        check(eq(Geometry.globalToLocal(CGRect(x: 10.5, y: 20.25, width: 1, height: 1), displayFrame: main),
                 CGRect(x: 10.5, y: 20.25, width: 1, height: 1)), "globalToLocal main is identity, Double kept")

        // clip
        check(eq(Geometry.clip(CGRect(x: 1400, y: 100, width: 300, height: 100), to: main),
                 CGRect(x: 1400, y: 100, width: 112, height: 100)), "clip right edge")
        check(Geometry.clip(CGRect(x: 5000, y: 5000, width: 10, height: 10), to: main) == nil, "clip no overlap is nil")
        check(Geometry.clip(CGRect(x: 1512, y: 0, width: 10, height: 10), to: main) == nil, "clip edge touch is nil")
        check(eq(Geometry.clip(CGRect(x: 10, y: 10, width: 20, height: 20), to: main),
                 CGRect(x: 10, y: 10, width: 20, height: 20)), "clip inside is unchanged")

        // union
        check(eq(Geometry.union([CGRect(x: 0, y: 0, width: 10, height: 10), CGRect(x: 20, y: 5, width: 10, height: 30)]),
                 CGRect(x: 0, y: 0, width: 30, height: 35)), "union of two")
        check(Geometry.union([]) == nil, "union of none is nil")
        check(eq(Geometry.union([CGRect.zero, CGRect(x: 5, y: 5, width: 1, height: 1)]),
                 CGRect(x: 5, y: 5, width: 1, height: 1)), "union ignores empty rects")

        // pickDisplay
        check(Geometry.pickDisplay(for: CGRect(x: 100, y: 100, width: 10, height: 10), displays: displays) == 0,
              "pick main by center")
        check(Geometry.pickDisplay(for: CGRect(x: 1400, y: 100, width: 400, height: 10), displays: displays) == 1,
              "pick by center over 2 displays")
        check(Geometry.pickDisplay(for: CGRect(x: 100, y: -500, width: 10, height: 10), displays: displays) == 2,
              "pick display above")
        check(Geometry.pickDisplay(for: CGRect(x: -50, y: 100, width: 60, height: 10), displays: displays) == 0,
              "pick by overlap when center is off all displays")
        check(Geometry.pickDisplay(for: CGRect(x: 9000, y: 9000, width: 10, height: 10), displays: displays) == nil,
              "pick nil when off all displays")

        // largestOverlap and bestDisplay
        check(Geometry.largestOverlap(CGRect(x: 1000, y: 0, width: 1000, height: 100), displays: displays) == 0,
              "largest overlap main 512 vs right 488")
        check(Geometry.bestDisplay(for: [CGRect(x: 1600, y: 0, width: 100, height: 100),
                                         CGRect(x: 0, y: 0, width: 50, height: 50)], displays: displays) == 1,
              "best display by sum of area")
        check(Geometry.bestDisplay(for: [], displays: displays) == nil, "best display of none is nil")

        // outputSize
        let s1 = Geometry.outputSize(points: CGSize(width: 1512, height: 982), scale: 2, maxSize: nil)
        check(s1.width == 3024 && s1.height == 1964, "output size native 2x")
        let s2 = Geometry.outputSize(points: CGSize(width: 1512, height: 982), scale: 2, maxSize: 800)
        check(s2.width == 800 && s2.height == 520, "output size maxSize 800 keeps ratio")
        let s3 = Geometry.outputSize(points: CGSize(width: 100, height: 400), scale: 1, maxSize: 200)
        check(s3.width == 50 && s3.height == 200, "output size maxSize on tall image")
        let s4 = Geometry.outputSize(points: CGSize(width: 100, height: 50), scale: 2, maxSize: 4000)
        check(s4.width == 200 && s4.height == 100, "output size no upscale")
        let s5 = Geometry.outputSize(points: CGSize(width: 10000, height: 1), scale: 1, maxSize: 64)
        check(s5.width == 64 && s5.height == 1, "output size min edge 1")
        let s6 = Geometry.outputSize(points: CGSize(width: 100, height: 100), scale: 0, maxSize: nil)
        check(s6.width == 100 && s6.height == 100, "output size scale 0 falls back to 1")

        // pixelToGlobal round trip
        let bbox = CGRect(x: 1512, y: -100, width: 1920, height: 1080)
        let p = Geometry.pixelToGlobal(px: 400, py: 225, bbox: bbox, scale: 800.0 / 1920.0)
        check(near(p.x, 2472) && near(p.y, 440), "pixel to global with maxSize scale")

        // framesMatch and matchWindowIds
        let f = CGRect(x: 100, y: 100, width: 800, height: 600)
        check(Geometry.framesMatch(f, CGRect(x: 101.5, y: 99, width: 801, height: 598)), "frames match in 2 pt")
        check(!Geometry.framesMatch(f, CGRect(x: 103, y: 100, width: 800, height: 600)), "frames differ over 2 pt")
        let keys = [
            Geometry.WindowKey(id: 1, pid: 10, frame: f, title: "A"),
            Geometry.WindowKey(id: 2, pid: 10, frame: f, title: "B"),
            Geometry.WindowKey(id: 3, pid: 11, frame: f, title: "A"),
            Geometry.WindowKey(id: 4, pid: 10, frame: CGRect(x: 0, y: 0, width: 50, height: 50), title: "A"),
        ]
        check(Geometry.matchWindowIds(pid: 10, frame: f, title: "A", in: keys) == [1], "match by pid frame title")
        let parked = CGRect(x: 900, y: 900, width: 500, height: 400)
        check(Geometry.matchWindowIds(pid: 10, frame: parked, title: "B", in: keys) == [2],
              "no frame match: fall back to pid + exact title")
        check(Geometry.matchWindowIds(pid: 10, frame: parked, title: "A", in: keys) == [1, 4],
              "title fallback keeps all candidates (ambiguous)")
        check(Geometry.matchWindowIds(pid: 10, frame: parked, title: nil, in: keys).isEmpty,
              "no frame match and no title gives none")
        check(Geometry.matchWindowIds(pid: 10, frame: f, title: nil, in: keys) == [1, 2], "two candidates without title")
        check(Geometry.matchWindowIds(pid: 10, frame: f, title: "Z", in: keys) == [1, 2], "title miss keeps frame matches")
        check(Geometry.matchWindowIds(pid: 12, frame: f, title: "A", in: keys).isEmpty, "other pid gives none")

        // bboxArray and round4
        check(Geometry.bboxArray(CGRect(x: 1.234, y: 2, width: 3, height: 4.567)) == [1.23, 2, 3, 4.57], "bbox array rounds")
        check(Geometry.round4(2.0 / 3.0) == 0.6667, "round4")
        let enc = { (n: NSNumber) in String(decoding: Json.encode([n]), as: UTF8.self) }
        check(enc(Geometry.jsonNumber(0.7072)) == "[0.7072]", "json number keeps the short form")
        check(enc(Geometry.jsonNumber(2)) == "[2]", "json number integer")

        // Retention
        let now = Date(timeIntervalSince1970: 1_000_000)
        let old = now.addingTimeInterval(-25 * 3600)
        let fresh = now.addingTimeInterval(-3600)
        var entries: [Retention.Entry] = []
        for i in 0..<5 { entries.append(.init(name: "shot-old\(i).png", modified: old.addingTimeInterval(Double(i)))) }
        for i in 0..<3 { entries.append(.init(name: "shot-new\(i).png", modified: fresh.addingTimeInterval(Double(i)))) }
        entries.append(.init(name: "notes.txt", modified: old))
        let del = Set(Retention.toDelete(entries, now: now, keep: 4))
        check(del == ["shot-old0.png", "shot-old1.png", "shot-old2.png", "shot-old3.png"], "retention keeps newest 4")
        check(Retention.toDelete(entries, now: now, keep: 200).isEmpty, "retention keeps all under 200")
        let del2 = Set(Retention.toDelete(entries, now: now, keep: 1))
        check(!del2.contains("shot-new0.png") && del2.count == 5, "retention never deletes fresh files")
        check(!del2.contains("notes.txt"), "retention ignores other files")

        retentionOnDisk()
        bridgeChecks()
        rangeChecks()
        outputDirChecks()
        occludedChecks()

        // Protocol handshake: the TS client stops a helper with a lower number.
        // `ping` reads the grants with preflight calls only (no prompt).
        let ping = Router.handle(route: "ping", rawBody: [:])
        check(ping.status == 200 && (ping.json as? [String: Any])?["protocol"] as? Int == 2,
              "ping gives protocol 2")

        let total = passed + failed.count
        if failed.isEmpty {
            print("selftest: \(passed)/\(total) passed")
            return 0
        }
        print("selftest: \(passed)/\(total) passed, \(failed.count) failed")
        for name in failed { print("FAIL: \(name)") }
        return 1
    }

    /// R14: `Retention.prune` on a real folder. 3 old shot files, 1 other
    /// file, and 1 directory with a shot name. With keep 1, the newest shot
    /// file, the other file and the directory stay.
    private static func retentionOnDisk() {
        let fm = FileManager.default
        let dir = (NSTemporaryDirectory() as NSString)
            .appendingPathComponent("ma-cu-selftest-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString)")
        do {
            try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
            let now = Date()
            let names = ["shot-1.png", "shot-2.png", "shot-3.png", "notes.txt"]
            for (i, n) in names.enumerated() {
                let p = (dir as NSString).appendingPathComponent(n)
                try Data("x".utf8).write(to: URL(fileURLWithPath: p))
                // shot-3 is the newest. All are older than 24 h.
                let m = now.addingTimeInterval(-Double(48 - i) * 3600)
                try fm.setAttributes([.modificationDate: m], ofItemAtPath: p)
            }
            let sub = (dir as NSString).appendingPathComponent("shot-dir.png")
            try fm.createDirectory(atPath: sub, withIntermediateDirectories: false)
            try Data("keep".utf8).write(to: URL(fileURLWithPath: (sub as NSString).appendingPathComponent("inner.txt")))
            try fm.setAttributes([.modificationDate: now.addingTimeInterval(-72 * 3600)], ofItemAtPath: sub)

            let deleted = Retention.prune(dir: dir, now: now, keep: 1)
            let left = Set(try fm.contentsOfDirectory(atPath: dir))
            check(deleted == 2, "retention on disk deletes 2 files")
            check(left == ["shot-3.png", "notes.txt", "shot-dir.png"], "retention on disk keeps newest, other file, dir")
            check(fm.fileExists(atPath: (sub as NSString).appendingPathComponent("inner.txt")),
                  "retention on disk keeps the directory content")
        } catch {
            check(false, "retention on disk setup: \(error.localizedDescription)")
        }
        try? fm.removeItem(atPath: dir)
        check(!fm.fileExists(atPath: dir), "retention on disk temp folder removed")
    }

    /// R1: `Bridge.wait` gives the value, the error, or a timeout. A late
    /// callback after the timeout must be safe.
    private static func bridgeChecks() {
        struct Probe: Error {}
        let v: Int? = try? Bridge.wait("probe", timeout: 1) { done in
            DispatchQueue.global().async { done(7, nil) }
        }
        check(v == 7, "bridge gives the callback value")

        var gotError = false
        do {
            let _: Int = try Bridge.wait("probe", timeout: 1) { done in done(nil, Probe()) }
        } catch is Probe { gotError = true } catch {}
        check(gotError, "bridge throws the callback error")

        var noResult = false
        do {
            let _: Int = try Bridge.wait("probe", timeout: 1) { done in done(nil, nil) }
        } catch Bridge.BridgeError.noResult { noResult = true } catch {}
        check(noResult, "bridge throws noResult for nil and nil")

        let late = DispatchSemaphore(value: 0)
        let start = Date()
        var timedOut = false
        var body: [String: Any] = [:]
        do {
            let _: Int = try Bridge.wait("probe", timeout: 0.05) { done in
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) {
                    done(1, nil)
                    late.signal()
                }
            }
        } catch {
            timedOut = Bridge.isTimeout(error)
            body = Bridge.softError("probe failed", error)
        }
        let waited = Date().timeIntervalSince(start)
        check(timedOut && waited < 0.15, "bridge times out and does not wait for the callback")
        check((body["error"] as? String)?.contains("timeout") == true && body["hint"] is String,
              "bridge timeout soft error has error and hint")
        check(late.wait(timeout: .now() + 2) == .success, "bridge late callback runs safely")
    }

    /// R3: numbers that do not fit their native type give a 400 text.
    private static func rangeChecks() {
        check(Router.rangeError(Body(["pid": 123])) == nil, "range pid ok")
        check(Router.rangeError(Body([:])) == nil, "range absent ok")
        check(Router.rangeError(Body(["pid": 1e10])) != nil, "range pid 1e10 is 400")
        check(Router.rangeError(Body(["pid": NSNumber(value: Int64(Int32.max) + 1)])) != nil, "range pid over Int32 is 400")
        check(Router.rangeError(Body(["pid": Double.infinity])) != nil, "range pid infinity is 400")
        check(Router.rangeError(Body(["pid": "99999999999"])) != nil, "range pid string over Int32 is 400")
        check(Router.rangeError(Body(["windowId": -1])) != nil, "range windowId negative is 400")
        check(Router.rangeError(Body(["windowId": NSNumber(value: UInt32.max)])) == nil, "range windowId UInt32 max ok")
        check(Router.rangeError(Body(["displayId": 5e9])) != nil, "range displayId over UInt32 is 400")
        check(Router.rangeError(Body(["dy": 3e9])) != nil, "range dy over Int32 is 400")
        check(Body(["pid": 1e10]).int("pid").flatMap { Int32(exactly: $0) } == nil, "Int32 exactly does not trap")
    }

    /// R6: `~` expands, a relative path is a 400, and the default compare uses
    /// the expanded path.
    private static func outputDirChecks() {
        let home = NSHomeDirectory()
        let def = (home as NSString).appendingPathComponent("Library/Application Support/ma-computer-use/screenshots")
        let a = Router.resolveOutputDir(nil, defaultDir: def)
        check(a?.dir == def && a?.isDefault == true, "outputDir absent is the default")
        let b = Router.resolveOutputDir("~/Library/Application Support/ma-computer-use/screenshots", defaultDir: def)
        check(b?.dir == def && b?.isDefault == true, "outputDir tilde expands to the default")
        let c = Router.resolveOutputDir("~/shots", defaultDir: def)
        check(c?.dir == (home as NSString).appendingPathComponent("shots") && c?.isDefault == false,
              "outputDir tilde custom")
        check(Router.resolveOutputDir("shots/x", defaultDir: def) == nil, "outputDir relative is nil (400)")
        check(Router.resolveOutputDir("", defaultDir: def) == nil, "outputDir empty is nil (400)")
        let d = Router.resolveOutputDir("/var/tmp/x", defaultDir: def)
        check(d?.dir == "/var/tmp/x" && d?.isDefault == false, "outputDir absolute kept")
    }

    /// R5: the occluded rules.
    private static func occludedChecks() {
        typealias O = ScreenshotService.Occluder
        let t = CGRect(x: 100, y: 100, width: 800, height: 600)
        let target = O(id: 9, pid: 50, bounds: t, layer: 0, alpha: 1)
        func occ(_ front: [O], skip: Set<Int> = [20]) -> Bool {
            ScreenshotService.isOccluded(id: 9, pid: 50, bbox: t, onScreen: front + [target], skipLayers: skip)
        }
        check(!occ([]), "occluded none in front")
        check(occ([O(id: 1, pid: 60, bounds: CGRect(x: 500, y: 500, width: 600, height: 400), layer: 0, alpha: 1)]),
              "occluded other app window")
        check(!occ([O(id: 2, pid: 50, bounds: CGRect(x: 200, y: 150, width: 400, height: 300), layer: 0, alpha: 1)]),
              "occluded skips own sheet inside bounds")
        check(occ([O(id: 3, pid: 50, bounds: CGRect(x: 800, y: 150, width: 400, height: 300), layer: 0, alpha: 1)]),
              "occluded counts own window outside bounds")
        check(!occ([O(id: 4, pid: 60, bounds: CGRect(x: 200, y: 200, width: 10, height: 10), layer: 0, alpha: 1)]),
              "occluded skips tiny window")
        check(!occ([O(id: 5, pid: 60, bounds: CGRect(x: 200, y: 200, width: 300, height: 300), layer: 0, alpha: 0)]),
              "occluded skips invisible window")
        check(occ([O(id: 6, pid: 60, bounds: CGRect(x: 200, y: 200, width: 300, height: 300), layer: 3, alpha: 1)]),
              "occluded counts floating panel")
        check(!occ([O(id: 7, pid: 60, bounds: CGRect(x: 0, y: 0, width: 2000, height: 25), layer: 25, alpha: 1)]),
              "occluded skips layer over 24")
        check(!occ([O(id: 8, pid: 60, bounds: CGRect(x: 0, y: 600, width: 2000, height: 80), layer: 20, alpha: 1)]),
              "occluded skips a system layer")
        check(!ScreenshotService.isOccluded(id: 9, pid: 50, bbox: t, onScreen: [
            target, O(id: 1, pid: 60, bounds: t, layer: 0, alpha: 1),
        ]), "occluded ignores windows behind")
    }
}
