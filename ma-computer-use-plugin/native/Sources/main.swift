import AppKit
import Foundation

/// ComputerUseHelper daemon entry point.
///
/// A signed, LSUIElement background-agent .app that listens on a unix domain
/// socket and serves the computer-use route set (AX inspect/interact, CGEvent
/// mouse/keyboard, ScreenCaptureKit screenshots). TCC grants attach to this
/// signed bundle so they persist across rebuilds.
///
/// Modes:
///   ComputerUseHelper            → run the daemon (default)
///   ComputerUseHelper --check    → print permission status as JSON and exit
///   ComputerUseHelper --prompt   → fire permission prompts + open Settings, exit

func socketPath() -> String {
    if let s = ProcessInfo.processInfo.environment["CUD_SOCK"] { return s }
    let dir = (NSHomeDirectory() as NSString)
        .appendingPathComponent("Library/Application Support/ma-computer-use")
    return (dir as NSString).appendingPathComponent("cud.sock")
}

func logLine(_ s: String) {
    FileHandle.standardError.write(Data("[ComputerUseHelper] \(s)\n".utf8))
}

let args = CommandLine.arguments

if args.contains("--check") {
    let status = Permissions.status()
    let data = try? JSONSerialization.data(withJSONObject: status, options: [.sortedKeys])
    print(String(data: data ?? Data("{}".utf8), encoding: .utf8) ?? "{}")
    exit(0)
}

if args.contains("--prompt") {
    let r = Permissions.handle(prompt: true, pane: "input")
    let data = try? JSONSerialization.data(withJSONObject: r, options: [.sortedKeys])
    print(String(data: data ?? Data("{}".utf8), encoding: .utf8) ?? "{}")
    // Give the prompts a moment to register.
    Thread.sleep(forTimeInterval: 0.5)
    exit(0)
}

// Daemon mode.
let sock = socketPath()
let server = HTTPServer(socketPath: sock) { route, body in
    Router.handle(route: route, rawBody: body)
}

do {
    try server.start()
    logLine("listening on \(sock)")
} catch {
    logLine("fatal: \(error.localizedDescription)")
    exit(1)
}

// Accept loop on a background thread; main thread runs the run loop so AppKit /
// ScreenCaptureKit / NSWorkspace work and libdispatch is serviced.
let acceptThread = Thread {
    server.acceptLoop()
}
acceptThread.stackSize = 4 * 1024 * 1024
acceptThread.start()

// Clean shutdown via dispatch signal sources (signal handlers can't safely call
// AppKit; a dispatch source runs the handler on a normal queue).
func installSignal(_ sig: Int32) -> DispatchSourceSignal {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler {
        server.stop()
        NSApplication.shared.terminate(nil)
    }
    src.resume()
    return src
}
let sigTerm = installSignal(SIGTERM)
let sigInt = installSignal(SIGINT)
_ = (sigTerm, sigInt)  // keep alive

// Run as an accessory app (no Dock icon). LSUIElement already does this; set
// activation policy explicitly for safety.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.run()
