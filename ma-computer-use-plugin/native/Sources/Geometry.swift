import CoreGraphics
import Foundation

/// Pure geometry for screenshot targets. All rects are global points with a
/// top-left origin, unless the name says "local". These functions make no
/// system calls, so `--selftest` can check each one.
enum Geometry {
    /// Convert a global rect to the local space of one display.
    static func globalToLocal(_ rect: CGRect, displayFrame: CGRect) -> CGRect {
        rect.offsetBy(dx: -displayFrame.origin.x, dy: -displayFrame.origin.y)
    }

    /// The part of `rect` inside `bounds`, or nil when no area stays.
    static func clip(_ rect: CGRect, to bounds: CGRect) -> CGRect? {
        let r = rect.standardized.intersection(bounds.standardized)
        if r.isNull || r.width <= 0 || r.height <= 0 { return nil }
        return r
    }

    /// The bounding rect of all rects with an area, or nil for none.
    static func union(_ rects: [CGRect]) -> CGRect? {
        var u = CGRect.null
        for r in rects where !r.isNull && r.width > 0 && r.height > 0 {
            u = u.union(r.standardized)
        }
        return u.isNull ? nil : u
    }

    /// The area of the intersection of two rects, in square points.
    static func overlapArea(_ a: CGRect, _ b: CGRect) -> Double {
        guard let r = clip(a, to: b) else { return 0 }
        return Double(r.width) * Double(r.height)
    }

    /// The index of the display with the largest overlap, or nil for no overlap.
    static func largestOverlap(_ rect: CGRect, displays: [CGRect]) -> Int? {
        var best: Int?
        var bestArea = 0.0
        for (i, d) in displays.enumerated() {
            let a = overlapArea(rect, d)
            if a > bestArea {
                best = i
                bestArea = a
            }
        }
        return best
    }

    /// The display that has the rect center. If no display has the center, the
    /// display with the largest overlap. Nil when the rect is on no display.
    static func pickDisplay(for rect: CGRect, displays: [CGRect]) -> Int? {
        let c = CGPoint(x: rect.midX, y: rect.midY)
        if let i = displays.firstIndex(where: { $0.contains(c) }) { return i }
        return largestOverlap(rect, displays: displays)
    }

    /// The display with the largest sum of overlap with a set of rects
    /// (for example, all windows of one app). Nil when no rect is on a display.
    static func bestDisplay(for rects: [CGRect], displays: [CGRect]) -> Int? {
        var best: Int?
        var bestArea = 0.0
        for (i, d) in displays.enumerated() {
            let a = rects.reduce(0.0) { $0 + overlapArea($1, d) }
            if a > bestArea {
                best = i
                bestArea = a
            }
        }
        return best
    }

    /// Output size in pixels for a capture of `points` at `scale` pixels per
    /// point. When `maxSize` is set, the long edge is at most `maxSize`, with
    /// the same aspect ratio. No upscale. Each edge is at least 1.
    static func outputSize(points: CGSize, scale: Double, maxSize: Int?) -> (width: Int, height: Int) {
        let s = scale > 0 ? scale : 1
        var w = Double(points.width) * s
        var h = Double(points.height) * s
        if let m = maxSize, m > 0 {
            let long = max(w, h)
            if long > Double(m) {
                let f = Double(m) / long
                w *= f
                h *= f
                w = min(w, Double(m))
                h = min(h, Double(m))
            }
        }
        return (max(1, Int(w.rounded())), max(1, Int(h.rounded())))
    }

    /// Map an image pixel to a global point: bbox origin + pixel / scale.
    static func pixelToGlobal(px: Double, py: Double, bbox: CGRect, scale: Double) -> CGPoint {
        let s = scale > 0 ? scale : 1
        return CGPoint(x: Double(bbox.origin.x) + px / s, y: Double(bbox.origin.y) + py / s)
    }

    /// True when each edge of the two frames differs by `tolerance` or less.
    static func framesMatch(_ a: CGRect, _ b: CGRect, tolerance: Double = 2) -> Bool {
        abs(Double(a.minX - b.minX)) <= tolerance
            && abs(Double(a.minY - b.minY)) <= tolerance
            && abs(Double(a.width - b.width)) <= tolerance
            && abs(Double(a.height - b.height)) <= tolerance
    }

    /// One window for the AX to window id match.
    struct WindowKey {
        let id: UInt32
        let pid: Int32
        let frame: CGRect
        let title: String?
    }

    /// The ids of the windows that agree with an AX window: the same pid and
    /// a frame within 2 points. When the AX title is not empty and some of
    /// these windows have the same title, only those windows stay.
    static func matchWindowIds(pid: Int32, frame: CGRect, title: String?, in windows: [WindowKey]) -> [UInt32] {
        let byFrame = windows.filter { $0.pid == pid && framesMatch($0.frame, frame) }
        if let t = title, !t.isEmpty {
            let byTitle = byFrame.filter { $0.title == t }
            if !byTitle.isEmpty { return byTitle.map(\.id) }
        }
        if !byFrame.isEmpty { return byFrame.map(\.id) }
        // Stage Manager parks a window as a small thumbnail: the CG bounds are the
        // thumbnail, the AX frame is the real window. Then match on pid + exact title.
        guard let t = title, !t.isEmpty else { return [] }
        return windows.filter { $0.pid == pid && $0.title == t }.map(\.id)
    }

    /// A rect as `[x, y, w, h]`, rounded to 2 decimals.
    static func bboxArray(_ r: CGRect) -> [Double] {
        [round2(r.origin.x), round2(r.origin.y), round2(r.size.width), round2(r.size.height)]
    }

    /// Round to 4 decimals, for a scale value in JSON.
    static func round4(_ v: Double) -> Double { (v * 10_000).rounded() / 10_000 }

    /// A JSON-safe number. JSONSerialization writes a Double with 17 digits
    /// (0.7072 becomes 0.70720000000000005). NSDecimalNumber from the short
    /// description keeps the short form.
    static func jsonNumber(_ v: Double) -> NSNumber {
        if v == v.rounded(), abs(v) < 1e15 { return NSNumber(value: Int64(v)) }
        return NSDecimalNumber(string: String(v))
    }

    /// `bboxArray` as JSON-safe numbers.
    static func bboxJSON(_ r: CGRect) -> [NSNumber] { bboxArray(r).map(jsonNumber) }
}
