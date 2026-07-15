/**
 * Model-facing prompt/template helpers for at-mention peer tags.
 *
 * Prompt-only module (mirrors core src PROMPTS modules): pure string builders,
 * no I/O, no host imports. Every string that ships to the model or session
 * history for peer mentions is authored here so the wire form stays auditable.
 *
 */

/** Inputs for formatPeerMentionXml. */
export interface PeerMentionXmlArgs {
  /** Full session uuid (required address key). */
  readonly sid: string
  /** Opt-in display name, e.g. Michelle. Omitted when naming is off. */
  readonly name?: string
  /**
   * Tag body: the original user-typed token including the leading at-sign
   * (e.g. at-Michelle or at-short-sid). Preserved so the model sees what
   * the human typed, while attrs carry the resolved identity.
   */
  readonly body: string
}

/** Escape a value for use inside a double-quoted XML attribute. */
export function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/**
 * Model-facing peer mention tag.
 *
 * Shape:
 *   ma::intercom::peer name=Michelle sid=full-uuid ... body=at-Michelle
 *
 * name attr is omitted when absent. Body is always the original at-token.
 * This is the wire/history form; the TUI keeps the plain at-token styled.
 */
export function formatPeerMentionXml(args: PeerMentionXmlArgs): string {
  const attrs: string[] = []
  if (args.name !== undefined && args.name.length > 0) {
    attrs.push('name="' + escapeXmlAttr(args.name) + '"')
  }
  attrs.push('sid="' + escapeXmlAttr(args.sid) + '"')
  // Body is user-typed text. Escape < / & so a hostile token can't break
  // the tag stream, but keep at-sign and alnum identifiers readable.
  const body = escapeXmlText(args.body)
  return "<ma::intercom::peer " + attrs.join(" ") + ">" + body + "</ma::intercom::peer>"
}

/** Escape text node content (body of the peer tag). */
export function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
