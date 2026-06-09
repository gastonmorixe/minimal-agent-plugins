import Foundation

/// Minimal helpers around Foundation's JSONSerialization for the dynamic
/// request/response bodies the daemon speaks. Requests arrive as `[String: Any]`,
/// responses are built as `[String: Any]` / `[Any]` and serialized back.
enum Json {
    /// Parse a JSON object body. Returns an empty dict for empty/blank input,
    /// nil only when the bytes are present but not a JSON object.
    static func parseObject(_ data: Data) -> [String: Any]? {
        if data.isEmpty { return [:] }
        let trimmed = data.trimmingTrailingWhitespaceLikeBytes()
        if trimmed.isEmpty { return [:] }
        guard let obj = try? JSONSerialization.jsonObject(with: trimmed, options: [.fragmentsAllowed])
        else { return nil }
        if let dict = obj as? [String: Any] { return dict }
        return nil
    }

    /// Serialize any JSON-compatible value to UTF-8 bytes.
    static func encode(_ value: Any) -> Data {
        // NSNull, String, NSNumber, Bool, [Any], [String:Any] are all fine.
        if let data = try? JSONSerialization.data(
            withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys])
        {
            return data
        }
        // Fallback: stringify defensively.
        let fallback = ["error": "failed to encode response"]
        return (try? JSONSerialization.data(withJSONObject: fallback)) ?? Data("{}".utf8)
    }
}

extension Data {
    fileprivate func trimmingTrailingWhitespaceLikeBytes() -> Data {
        var end = count
        let ws: Set<UInt8> = [0x20, 0x09, 0x0a, 0x0d]
        while end > 0, ws.contains(self[startIndex + end - 1]) { end -= 1 }
        var start = 0
        while start < end, ws.contains(self[startIndex + start]) { start += 1 }
        return subdata(in: (startIndex + start)..<(startIndex + end))
    }
}

/// Typed accessors over a `[String: Any]` request body.
struct Body {
    let raw: [String: Any]
    init(_ raw: [String: Any]) { self.raw = raw }

    func string(_ key: String) -> String? { raw[key] as? String }
    func bool(_ key: String) -> Bool? {
        if let b = raw[key] as? Bool { return b }
        if let n = raw[key] as? NSNumber { return n.boolValue }
        return nil
    }
    func int(_ key: String) -> Int? {
        if let n = raw[key] as? NSNumber { return n.intValue }
        if let s = raw[key] as? String { return Int(s) }
        return nil
    }
    func double(_ key: String) -> Double? {
        if let n = raw[key] as? NSNumber { return n.doubleValue }
        if let s = raw[key] as? String { return Double(s) }
        return nil
    }
    func cgFloat(_ key: String) -> CGFloat? {
        if let d = double(key) { return CGFloat(d) }
        return nil
    }
    func stringArray(_ key: String) -> [String]? { raw[key] as? [String] }
    /// A value that may be string/number/bool, for setValue.
    func any(_ key: String) -> Any? { raw[key] }
}
