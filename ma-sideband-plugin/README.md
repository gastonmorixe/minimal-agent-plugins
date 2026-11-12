# ma-sideband-plugin

Required plugin. Provides the sideband codec `xml-ma-v1` (`sideband.codec`).

- `render` writes the current v1 wire form, byte for byte (`<ma::agent::kind a="b" />`).
- `parse` and the scanner read v1, v2 (`<ma:kind>`) and the bare legacy forms.
- `neutralize` defangs every sigil form so untrusted text cannot forge a tag.
- `example` builds a deterministic sample for a kind.

Known v1 quirk: v1 escapes per site, the strict single rule comes with xml-ma-v2.
Some tags write attribute values raw (mode-active, mode-change, raw-output), some
escape `& " <` (binary-result, redacted-asset, context-sanitizer), and the system
role tags escape `& < > "`. Bodies are never escaped in v1.

The module is pure: no exec, no file reads, relative and `@minimal-agent/core/plugin-api/*` imports only.
