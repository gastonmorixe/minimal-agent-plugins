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

v1 render does not replace control chars, matching today's emitters. xml-ma-v2 will.
Kinds in no escape list default to e4. They are not audited yet: S1.3 or later audits intercom-inbox, tasks, subagents, memory-saved.
The scanner holds an unfinished opener up to 1024 chars and an unfinished body up to 65536 chars. Beyond the cap the text passes through as plain text.

The module is pure: no exec, no file reads, relative and `@minimal-agent/core/plugin-api/*` imports only.
