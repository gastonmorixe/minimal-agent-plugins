# ma-sideband-plugin

Required plugin. Provides the sideband codec `xml-ma-v1` (`sideband.codec`).

- `render` writes the current v1 wire form, byte for byte (`<ma::agent::kind a="b" />`).
- `parse` and the scanner read v1, v2 (`<ma:kind>`) and the bare legacy forms.
- `neutralize` defangs every sigil form so untrusted text cannot forge a tag.
- `example` builds a deterministic sample for a kind.

Known v1 quirk: v1 escapes per site, the strict single rule comes with xml-ma-v2.

## Per-kind rows and the parity suite

`lib/escape.ts` has one checked row for each kind: the attribute escape
(`raw`, `e3` = `& " <`, `e4` = `& < > "`, `aq` = `& "`) and the body escape
(`raw`, `lt-gt` = `< >`, `text` = `& < >`). Kinds in no row use `e4` and a raw body.
Examples: `memory-saved` is `aq` with an `lt-gt` body, `intercom-peer` is `e4`
with a `text` body, `output-preview` and the mode tags are `raw`.

`lib/levels.ts` has the v1 wire names: the qname of each kind (also
`max-tokens-continue` -> `ma::agent::output-truncated`) and the attribute wire
names. The declared `chars-removed` of `redacted-asset` and `context-sanitizer`
is written as `chars_removed`; `parse` maps it back.

`lib/parity.test.ts` pins `render` against the bytes of each `ma::` emitter of
today. It calls the plugin emitter when it can be imported. Core emitters are
literals with their file:line.

v1 render does not replace control chars, matching today's emitters. xml-ma-v2 will.
The scanner holds an unfinished opener up to 1024 chars and an unfinished body up to 65536 chars. Beyond the cap the text passes through as plain text.

The module is pure: no exec, no file reads, relative and `@minimal-agent/core/plugin-api/*` imports only.
