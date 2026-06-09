import Foundation

/// A tiny HTTP/1.1 server over a UNIX domain socket. We speak HTTP-over-unix to
/// mirror ma-chrome-cdp-plugin exactly so the bun client (`fetch(url,{unix})`)
/// is reused verbatim. A unix socket is a filesystem object, not "network", so
/// it never trips the macOS Local Network privacy prompt.
///
/// Deliberately minimal: one request per connection, Content-Length bodies only,
/// no keep-alive. Each accepted connection is handled on a serial work queue
/// because every AX call is synchronous IPC and must be serialized anyway.
final class HTTPServer {
    typealias Handler = (_ route: String, _ body: [String: Any]) -> (status: Int, json: Any)

    private let socketPath: String
    private let handler: Handler
    private let work = DispatchQueue(label: "dev.gastonmorixe.computeruse.work")
    private var listenFD: Int32 = -1
    private var accepting = false

    init(socketPath: String, handler: @escaping Handler) {
        self.socketPath = socketPath
        self.handler = handler
    }

    /// Bind + listen. Throws a POSIXError-ish NSError on failure.
    func start() throws {
        // Ensure parent dir exists.
        let dir = (socketPath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(
            atPath: dir, withIntermediateDirectories: true)

        // Remove a stale socket file.
        unlink(socketPath)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw err("socket() failed: \(errnoString())") }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path) - 1
        guard pathBytes.count <= maxLen else {
            close(fd)
            throw err("socket path too long (\(pathBytes.count) > \(maxLen)): \(socketPath)")
        }
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: UInt8.self, capacity: maxLen + 1) { dst in
                for (i, b) in pathBytes.enumerated() { dst[i] = b }
                dst[pathBytes.count] = 0
            }
        }

        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bindResult = withUnsafePointer(to: &addr) { p -> Int32 in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                bind(fd, sa, size)
            }
        }
        guard bindResult == 0 else {
            close(fd)
            throw err("bind() failed: \(errnoString())")
        }
        // Only the user can talk to the socket.
        chmod(socketPath, 0o600)

        guard listen(fd, 64) == 0 else {
            close(fd)
            throw err("listen() failed: \(errnoString())")
        }
        listenFD = fd
        accepting = true
    }

    /// Run the accept loop (blocks the calling thread). Call on a background thread.
    func acceptLoop() {
        while accepting {
            let clientFD = accept(listenFD, nil, nil)
            if clientFD < 0 {
                if errno == EINTR { continue }
                if !accepting { break }
                continue
            }
            work.async { [weak self] in
                self?.serve(clientFD)
            }
        }
    }

    func stop() {
        accepting = false
        if listenFD >= 0 { close(listenFD) }
        unlink(socketPath)
    }

    // MARK: - Per-connection

    private func serve(_ fd: Int32) {
        defer { close(fd) }
        guard let (route, body) = readRequest(fd) else {
            writeResponse(fd, status: 400, json: ["error": "malformed request"])
            return
        }
        let result = handler(route, body)
        writeResponse(fd, status: result.status, json: result.json)
    }

    /// Read one HTTP request: request line + headers + Content-Length body.
    private func readRequest(_ fd: Int32) -> (route: String, body: [String: Any])? {
        var buffer = Data()
        var headerEnd: Range<Data.Index>?
        // Read until we have the header terminator.
        while headerEnd == nil {
            guard let chunk = readChunk(fd), !chunk.isEmpty else { break }
            buffer.append(chunk)
            headerEnd = buffer.range(of: Data("\r\n\r\n".utf8))
            if buffer.count > 8 * 1024 * 1024 { return nil }  // guard runaway headers
        }
        guard let he = headerEnd else { return nil }

        let headerData = buffer.subdata(in: buffer.startIndex..<he.lowerBound)
        guard let headerText = String(data: headerData, encoding: .utf8) else { return nil }
        let lines = headerText.split(separator: "\r\n", omittingEmptySubsequences: false)
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        let path = String(parts[1])
        let route = path.hasPrefix("/") ? String(path.dropFirst()) : path

        // Parse Content-Length.
        var contentLength = 0
        for line in lines.dropFirst() {
            let lower = line.lowercased()
            if lower.hasPrefix("content-length:") {
                let v = line.drop(while: { $0 != ":" }).dropFirst()
                contentLength = Int(v.trimmingCharacters(in: .whitespaces)) ?? 0
            }
        }

        var bodyData = buffer.subdata(in: he.upperBound..<buffer.endIndex)
        while bodyData.count < contentLength {
            guard let chunk = readChunk(fd), !chunk.isEmpty else { break }
            bodyData.append(chunk)
        }
        if bodyData.count > contentLength, contentLength > 0 {
            bodyData = bodyData.subdata(in: bodyData.startIndex..<(bodyData.startIndex + contentLength))
        }

        let parsed = Json.parseObject(bodyData) ?? [:]
        return (route, parsed)
    }

    private func readChunk(_ fd: Int32, max: Int = 64 * 1024) -> Data? {
        var buf = [UInt8](repeating: 0, count: max)
        let n = read(fd, &buf, max)
        if n <= 0 { return nil }
        return Data(buf[0..<n])
    }

    private func writeResponse(_ fd: Int32, status: Int, json: Any) {
        let payload = Json.encode(json)
        let reason = Self.reason(status)
        var header = "HTTP/1.1 \(status) \(reason)\r\n"
        header += "Content-Type: application/json\r\n"
        header += "Content-Length: \(payload.count)\r\n"
        header += "Connection: close\r\n\r\n"
        var out = Data(header.utf8)
        out.append(payload)
        out.withUnsafeBytes { rawBuf in
            var off = 0
            let base = rawBuf.bindMemory(to: UInt8.self).baseAddress!
            let total = rawBuf.count
            while off < total {
                let n = write(fd, base + off, total - off)
                if n <= 0 { break }
                off += n
            }
        }
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 409: return "Conflict"
        case 429: return "Too Many Requests"
        case 500: return "Internal Server Error"
        case 503: return "Service Unavailable"
        default: return "Status"
        }
    }

    private func err(_ message: String) -> NSError {
        NSError(domain: "ComputerUseHelper.HTTPServer", code: 1,
                userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func errnoString() -> String { String(cString: strerror(errno)) }
}
