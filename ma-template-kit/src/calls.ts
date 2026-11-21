/**
 * The percent-v1 call engine: vars, the `%%%%` escape and the
 * `%%sideband:...%%` calls in one left-to-right pass (design 50 section 1).
 * Pure, no IO, no core import.
 *
 * Grammar:
 *
 * ```
 * token  := "%%%%"                                -> literal "%%"
 *         | "%%" name ["?"] "%%"                  -> var, percent-v1 rules
 *         | "%%sideband:" op " " kind *(" " attr) "%%"
 * op     := "tag" | "open" | "close" | "name" | "example"
 * kind   := [a-z][a-z0-9-]*
 * attr   := key "=" value        key := [A-Za-z][A-Za-z0-9_-]*
 * value  := '"' [^"%\n]* '"'     literal, the quotes are removed
 *         | "@" name             value of var `name` (required)
 *         | [^\s"%]+             bare literal
 * ```
 *
 * The output of a token is never scanned again, so a var value cannot make a
 * tag or a var. `close` and `name` take no attrs. A malformed call token or an
 * unknown op throws {@link PromptTemplateSyntaxError}. An unknown kind throws
 * the error of the sideband API (with a codec, `SidebandKindUnknownError`).
 *
 * @module ma-template-kit/calls
 */

import {
  PromptTemplateError,
  PromptTemplateSyntaxError,
  type TemplateVar,
  type TemplateVars,
} from "./template.ts"

/** The ops of a `%%sideband:<op> ...%%` call. */
export const SIDEBAND_OPS = ["tag", "open", "close", "name", "example"] as const

/** One op of a `%%sideband:<op> ...%%` call. */
export type SidebandOp = (typeof SIDEBAND_OPS)[number]

/** One attribute value given to the sideband API. */
export type SidebandCallValue = string | number | boolean

/** The message shape that the engine gives to the sideband API. */
export interface SidebandCallMessage {
  /** Attribute values by declared name. */
  attrs?: Record<string, SidebandCallValue>
}

/**
 * The part of the core `SidebandApi` that the engine uses (structural, so the
 * kit has no core import). `open` and `close` are optional: an API with no
 * `open`/`close` renders `""` for those ops.
 */
export interface TemplateSideband {
  /** False when no codec is loaded. Then each op renders the kind name. */
  readonly ready: boolean
  /** A self-closing tag. */
  render(kind: string, msg?: SidebandCallMessage): string
  /** Only the start part. */
  open?(kind: string, msg?: SidebandCallMessage): string
  /** Only the end part. */
  close?(kind: string): string
  /** The name of a kind for prompt text. */
  name(kind: string): string
  /** An example of a kind for prompt text. */
  example(kind: string, msg?: SidebandCallMessage): string
}

/** The context of one expand call (same shape as core `PromptExpandContext`). */
export interface ExpandTemplateContext {
  /** Variable values. */
  vars?: TemplateVars
  /** The sideband API. Absent: each sideband op renders the kind name. */
  sideband?: TemplateSideband
  /** Source of the text, used only in error messages. */
  source?: string
}

/** Options of {@link expandTemplate}. */
export interface ExpandTemplateOptions {
  /** Trim the final string. Default false (the bytes stay as written). */
  trim?: boolean
  /**
   * A required var with no value: `"throw"` (default) throws
   * {@link PromptTemplateError} with all missing names; `"keep"` leaves the
   * token text as written.
   */
  missing?: "throw" | "keep"
}

/** One attribute of a parsed call: a literal or a var reference. */
export type SidebandCallAttr =
  | { key: string; value: string }
  | { key: string; varName: string }

/** A parsed `%%sideband:...%%` call. */
export interface SidebandCall {
  /** The op. */
  op: SidebandOp
  /** The kind name. */
  kind: string
  /** The attributes, in written order. */
  attrs: SidebandCallAttr[]
}

const PREFIX = "%%sideband:"
const VAR_RE = /%%([A-Za-z0-9_.-]+)(\?)?%%/y
const OP_RE = /[a-z]+/y
const KIND_RE = /[a-z][a-z0-9-]*/y
const ATTR_RE = /([A-Za-z][A-Za-z0-9_-]*)=(?:"([^"%\n]*)"|@([A-Za-z0-9_.-]+)|([^\s"%]+))/y

function isOp(s: string): s is SidebandOp {
  return (SIDEBAND_OPS as readonly string[]).includes(s)
}

/** Match `re` (sticky) at `pos` of `s`. */
function at(re: RegExp, s: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos
  return re.exec(s)
}

/**
 * Parse the inner text of a call token (the text between `%%sideband:` and
 * the end `%%`).
 *
 * @param inner - The inner text, for example `tag raw-output path="/a b"`.
 * @param token - The full token, for the error message.
 * @param offset - Offset of the token, for the error message.
 * @param source - Template path, for the error message.
 * @throws PromptTemplateSyntaxError for a malformed token or an unknown op.
 */
export function parseSidebandCall(
  inner: string,
  token = `${PREFIX}${inner}%%`,
  offset = 0,
  source?: string,
): SidebandCall {
  const fail = (reason: string): never => {
    throw new PromptTemplateSyntaxError(reason, token.slice(0, 80), offset, source)
  }
  const op = at(OP_RE, inner, 0)?.[0]
  if (op === undefined) return fail("a sideband call has no op")
  if (!isOp(op)) return fail(`unknown sideband op "${op}" (use ${SIDEBAND_OPS.join(", ")})`)
  let pos = op.length
  if (inner[pos] !== " ") return fail("a sideband call needs one space after the op")
  pos += 1
  const kind = at(KIND_RE, inner, pos)?.[0]
  if (kind === undefined) return fail("a sideband call has no valid kind")
  pos += kind.length
  const attrs: SidebandCallAttr[] = []
  const seen = new Set<string>()
  while (pos < inner.length) {
    if (inner[pos] !== " ") return fail("malformed sideband call after the kind")
    pos += 1
    const m = at(ATTR_RE, inner, pos)
    if (m === null) return fail("malformed sideband attribute")
    const key = m[1] as string
    if (seen.has(key)) return fail(`duplicate sideband attribute "${key}"`)
    seen.add(key)
    if (m[3] !== undefined) attrs.push({ key, varName: m[3] })
    else attrs.push({ key, value: m[2] ?? (m[4] as string) })
    pos += m[0].length
  }
  if ((op === "close" || op === "name") && attrs.length > 0) {
    return fail(`the sideband op "${op}" takes no attributes`)
  }
  return { op, kind, attrs }
}

/** Render one parsed call. */
function renderCall(
  call: SidebandCall,
  attrs: Record<string, SidebandCallValue>,
  sb: TemplateSideband | undefined,
): string {
  const { op, kind } = call
  if (sb === undefined) return kind
  if (!sb.ready) return sb.name(kind)
  const msg: SidebandCallMessage = call.attrs.length > 0 ? { attrs } : {}
  switch (op) {
    case "tag":
      return sb.render(kind, msg)
    case "open":
      return sb.open ? sb.open(kind, msg) : ""
    case "close":
      return sb.close ? sb.close(kind) : ""
    case "name":
      return sb.name(kind)
    case "example":
      return sb.example(kind, call.attrs.length > 0 ? msg : undefined)
  }
}

const present = (v: TemplateVar): v is string | number | boolean => v !== undefined && v !== null

/**
 * Expand vars, the `%%%%` escape and the `%%sideband:...%%` calls of
 * `template` in one pass. See the module grammar.
 *
 * @throws PromptTemplateSyntaxError for a malformed call token or an unknown op.
 * @throws PromptTemplateError when a required var has no value (`missing: "throw"`).
 */
export function expandTemplate(
  template: string,
  ctx: ExpandTemplateContext = {},
  opts: ExpandTemplateOptions = {},
): string {
  const vars = ctx.vars ?? {}
  const keep = opts.missing === "keep"
  const missing = new Set<string>()
  let droppedOptional = false
  let out = ""
  let last = 0
  let i = template.indexOf("%%")
  while (i !== -1) {
    let next = i + 1
    let piece: string | undefined
    if (template.startsWith("%%%%", i)) {
      piece = "%%"
      next = i + 4
    } else if (template.startsWith(PREFIX, i)) {
      const end = template.indexOf("%%", i + PREFIX.length)
      const nl = template.indexOf("\n", i)
      if (end === -1 || (nl !== -1 && nl < end)) {
        const stop = nl === -1 ? template.length : nl
        throw new PromptTemplateSyntaxError(
          "unterminated sideband call",
          template.slice(i, Math.min(stop, i + 80)),
          i,
          ctx.source,
        )
      }
      next = end + 2
      const token = template.slice(i, next)
      const call = parseSidebandCall(template.slice(i + PREFIX.length, end), token, i, ctx.source)
      const attrs: Record<string, SidebandCallValue> = {}
      let unresolved = false
      for (const a of call.attrs) {
        if ("value" in a) {
          attrs[a.key] = a.value
          continue
        }
        const v = vars[a.varName]
        if (present(v)) attrs[a.key] = v
        else {
          missing.add(a.varName)
          unresolved = true
        }
      }
      piece = unresolved ? token : renderCall(call, attrs, ctx.sideband)
    } else {
      const m = at(VAR_RE, template, i)
      if (m !== null) {
        next = i + m[0].length
        const name = m[1] as string
        const v = vars[name]
        if (present(v)) piece = String(v)
        else if (m[2]) {
          droppedOptional = true
          piece = ""
        } else {
          missing.add(name)
          piece = m[0]
        }
      }
    }
    if (piece !== undefined) {
      out += template.slice(last, i) + piece
      last = next
    }
    i = template.indexOf("%%", next)
  }
  out += template.slice(last)
  if (missing.size > 0 && !keep) throw new PromptTemplateError([...missing], ctx.source)
  // The percent-v1 rule: normalize only when an optional slot emptied.
  if (droppedOptional) out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
  return opts.trim === true ? out.trim() : out
}
