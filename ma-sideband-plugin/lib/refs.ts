const REF_RE = /&(?:(amp|lt|gt|quot|apos)|#(\d{1,7})|#x([0-9a-fA-F]{1,6}));/g
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

function isXmlChar(cp: number): boolean {
  if (cp === 0x9 || cp === 0xa || cp === 0xd) return true
  if (cp >= 0x20 && cp <= 0xd7ff) return true
  if (cp >= 0xe000 && cp <= 0xfffd) return true
  return cp >= 0x10000 && cp <= 0x10ffff
}

/**
 * Decode character references. Named refs always decode. Numeric refs decode
 * only when `numeric` is true and the code point is an XML Char. A bad ref
 * stays literal (SB-V2-12).
 */
export function decodeRefs(text: string, numeric: boolean): string {
  return text.replace(REF_RE, (whole, named?: string, dec?: string, hex?: string) => {
    if (named !== undefined) return NAMED[named] ?? whole
    if (!numeric) return whole
    const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16)
    return isXmlChar(cp) ? String.fromCodePoint(cp) : whole
  })
}

/** Decode a v1 backslash escape in an attribute value (SB-V1-7). */
export function decodeBackslash(text: string): string {
  return text.replace(/\\(["'\\nt])/g, (_w, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c))
}
