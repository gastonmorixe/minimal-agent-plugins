import { neutralizeText } from "./neutralize.ts"
import { makeContext, parseText } from "./parse.ts"
import { renderV1 } from "./render.ts"
import { createScanner } from "./scanner.ts"
import type {
  ReadonlySidebandRegistry,
  SidebandCodec,
  SidebandKind,
  SidebandMessage,
} from "./types.ts"

function buildExample(kind: SidebandKind): SidebandMessage {
  const attrs: Record<string, string | number | boolean> = {}
  for (const [name, decl] of Object.entries(kind.attrs)) {
    if (decl.type === "int") attrs[name] = 0
    else if (decl.type === "bool") attrs[name] = true
    else if (decl.type === "enum") attrs[name] = decl.values?.[0] ?? "..."
    else attrs[name] = "..."
  }
  const msg: SidebandMessage = { kind: kind.kind, attrs }
  if (kind.body !== "none") msg.body = "..."
  return msg
}

/**
 * Codec factory for `xml-ma-v1`. Renders the current v1 wire form, reads v1,
 * v2 and bare legacy forms, and neutralizes untrusted text.
 */
export default function createCodec(registry: ReadonlySidebandRegistry): SidebandCodec {
  return {
    id: "xml-ma-v1",
    render: (kind, msg) => renderV1(kind, msg),
    parse: (text) => parseText(text, makeContext(registry)),
    scanner: () => createScanner(registry),
    neutralize: (untrusted) => neutralizeText(untrusted),
    example: (kind, msg) => renderV1(kind, msg ?? kind.example ?? buildExample(kind)),
  }
}
