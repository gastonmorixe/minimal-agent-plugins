import type * as SB from "@minimal-agent/core/plugin-api/types/sideband"

/** Re-export of the sideband kind declaration type. */
export type SidebandKind = SB.SidebandKind
/** Re-export of the sideband message type. */
export type SidebandMessage = SB.SidebandMessage
/** Re-export of the sideband attribute declaration type. */
export type SidebandAttrDecl = SB.SidebandAttrDecl
/** Re-export of the read-only registry view type. */
export type ReadonlySidebandRegistry = SB.ReadonlySidebandRegistry

// LOCAL TYPES (design 40, section 2.0). Same names and shapes as the
// plugin-api additions. Replace each one with the plugin-api type when the
// core pin has them: SidebandForm, SidebandSpan, SidebandNode,
// SidebandParseOptions (plus `kinds`), StreamScanOptions, StreamScanner,
// SidebandCodec (optional `name`, `trailingStart`).

/** Wire form that produced a node. `v1-text` is an old bracket notice. */
export type SidebandForm = "v2" | "v1" | "v1-bare" | "v1-text"

/** A UTF-16 range of a text, end exclusive. */
export interface SidebandSpan {
  /** Start offset. */
  start: number
  /** End offset, exclusive. */
  end: number
}

/** A node the codec parsed from text. */
export interface SidebandNode {
  /** Kind name. */
  kind: string
  /** Attribute values by name. */
  attrs: Record<string, string>
  /** Optional body. */
  body?: string
  /** True when the node had no end marker. */
  selfClosing: boolean
  /** Wire form that produced the node. */
  form: SidebandForm
  /** Qualified name seen in a legacy form. */
  legacyQname?: string
  /** UTF-16 offsets of the full node, end exclusive. */
  span: SidebandSpan
  /** Span of the start part. */
  open?: SidebandSpan
  /** Span of the end part. Absent when the node is self-closing. */
  close?: SidebandSpan
}

/** Options of a codec `parse` call. */
export interface SidebandParseOptions {
  /** Only nodes of these kinds. Default: each node, also an unregistered kind. */
  kinds?: readonly string[]
  /** Also give the nodes inside a node body. Default false (top level only). */
  nested?: boolean
  /** Also read old bracket notices (form `v1-text`). Default false. */
  legacyText?: boolean
}

/** Re-export of the streaming scanner options type (kinds, codeAware, hold limits). */
export type StreamScanOptions = SB.StreamScanOptions

/** Streaming scanner made by a codec. */
export interface StreamScanner {
  /** Feed a chunk. */
  write(chunk: string): void
  /** Flush at end of stream. */
  end(): void
  /** Set the plain text callback. */
  onText(cb: (text: string) => void): void
  /** Set the node callback. */
  onNode(cb: (node: SidebandNode, raw: string) => void): void
}

/** Codec contract, with the optional members of design section 2.0. */
export interface SidebandCodec {
  /** Codec id. */
  id: string
  /** Render a message to text. */
  render(kind: SidebandKind, msg: SidebandMessage): string
  /** Parse text to nodes. */
  parse(text: string, opts?: SidebandParseOptions): SidebandNode[]
  /** Make a streaming scanner. */
  scanner(opts?: StreamScanOptions): StreamScanner
  /** Make untrusted text safe. */
  neutralize(untrusted: string): string
  /** Render an example for a kind. */
  example(kind: SidebandKind, msg?: SidebandMessage): string
  /** The wire name of a kind for prompt text (SB-DOC-2). */
  name?(kind: SidebandKind): string
  /** Start of the annotation region at the end of `text`, or `text.length`. */
  trailingStart?(text: string): number
  /** Remove complete nodes and broken tag parts (see `lenient.ts`). */
  stripLenient?(text: string, opts?: SidebandStripLenientOptions): string
  /** The node at the first non-space character of `text`, also a start part only. */
  leadingNode?(text: string): SidebandNode | undefined
}

/** Options of a codec `stripLenient` call. */
export interface SidebandStripLenientOptions {
  /** Only parts of these kinds. Default: each name that the codec maps to a kind. */
  kinds?: readonly string[]
  /** True: remove only the tag parts, and keep the body text. Default false. */
  keepBody?: boolean
  /** The text that replaces each removed part or node. Default `""`. */
  replacement?: string
}
