import ScreenCaptureKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import AppKit
import Foundation

/// One-shot screen capture via ScreenCaptureKit. The completion-handler API is
/// bridged to a synchronous call with a DispatchSemaphore because the daemon's
/// work queue is serial and SCKit's callback runs on its own internal queue (no
/// deadlock). Requires Screen Recording TCC permission.
enum ScreenshotService {
    enum CaptureError: Error { case noDisplay, captureFailed, encodeFailed, permission }

    /// Capture a display (or a global rect) to a PNG file, returning metadata.
    /// mode: "screen" (whole main/displayIndex), "area" (rect), "window" (windowId via AX bbox not supported here; use area).
    static func capture(mode: String, rect: CGRect?, displayIndex: Int?, format: String,
                        outputDir: String) -> [String: Any] {
        if !Permissions.screenRecordingGranted() {
            // Trigger the prompt path; report not-granted.
            Permissions.requestScreenRecording()
            return ["error": "screen recording permission not granted",
                    "hint": "call perms with prompt:true, then enable ComputerUseHelper in Settings"]
        }
        do {
            let image = try captureCGImage(mode: mode, rect: rect, displayIndex: displayIndex)
            let scale = backingScale(displayIndex: displayIndex)
            if format == "base64" {
                guard let data = pngData(image) else { return ["error": "encode failed"] }
                return [
                    "base64": data.base64EncodedString(),
                    "bytes": data.count,
                    "width": image.width,
                    "height": image.height,
                    "scale": scale,
                ]
            }
            // default: write to file
            try FileManager.default.createDirectory(
                atPath: outputDir, withIntermediateDirectories: true)
            let stamp = Int(Date().timeIntervalSince1970 * 1000)
            let path = (outputDir as NSString).appendingPathComponent("shot-\(stamp).png")
            guard let data = pngData(image) else { return ["error": "encode failed"] }
            try data.write(to: URL(fileURLWithPath: path))
            return [
                "path": path,
                "bytes": data.count,
                "width": image.width,
                "height": image.height,
                "scale": scale,
            ]
        } catch CaptureError.permission {
            return ["error": "screen recording permission not granted"]
        } catch {
            return ["error": "capture failed: \(error)"]
        }
    }

    private static func captureCGImage(mode: String, rect: CGRect?, displayIndex: Int?) throws -> CGImage {
        if #available(macOS 14.0, *) {
            let content = try shareableContent()
            let displays = content.displays
            guard !displays.isEmpty else { throw CaptureError.noDisplay }
            let display: SCDisplay
            if let idx = displayIndex, idx >= 0, idx < displays.count {
                display = displays[idx]
            } else {
                display = displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? displays[0]
            }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let cfg = SCStreamConfiguration()
            let scale = Int(filter.pointPixelScale == 0 ? 2 : filter.pointPixelScale)
            cfg.width = display.width * scale
            cfg.height = display.height * scale
            cfg.showsCursor = true
            if mode == "area", let r = rect {
                cfg.sourceRect = r
                cfg.width = Int(r.width) * scale
                cfg.height = Int(r.height) * scale
            }
            return try captureImageSync(filter: filter, config: cfg)
        } else {
            throw CaptureError.captureFailed
        }
    }

    @available(macOS 14.0, *)
    private static func shareableContent() throws -> SCShareableContent {
        let sem = DispatchSemaphore(value: 0)
        var result: SCShareableContent?
        var failure: Error?
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
            result = content
            failure = error
            sem.signal()
        }
        sem.wait()
        if let failure { throw failure }
        guard let result else { throw CaptureError.captureFailed }
        return result
    }

    @available(macOS 14.0, *)
    private static func captureImageSync(filter: SCContentFilter, config: SCStreamConfiguration) throws -> CGImage {
        let sem = DispatchSemaphore(value: 0)
        var image: CGImage?
        var failure: Error?
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { cgImage, error in
            image = cgImage
            failure = error
            sem.signal()
        }
        sem.wait()
        if let failure { throw failure }
        guard let image else { throw CaptureError.captureFailed }
        return image
    }

    private static func pngData(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data as CFMutableData, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }

    private static func backingScale(displayIndex: Int?) -> Double {
        let screens = NSScreen.screens
        if let idx = displayIndex, idx >= 0, idx < screens.count {
            return Double(screens[idx].backingScaleFactor)
        }
        return Double(NSScreen.main?.backingScaleFactor ?? 2)
    }
}
