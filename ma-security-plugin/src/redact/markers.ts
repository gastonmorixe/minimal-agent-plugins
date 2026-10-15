// Marker shape builders per redaction level (SPEC-v3 "Redaction levels").
// One marker shape: [REDACTED:<kind>:<tag>]. xhigh: [REDACTED:<tag>]. tag=off: [REDACTED].
import type { Level, RedactRule } from "../rules/types.ts"

export type MarkerRender = RedactRule["render"]

export type MarkerInput = {
  /** The raw value to replace. */
  value: string
  /** Marker kind ("anthropic.oauth-access", "email"). */
  kind: string
  /** 8 hex chars, or null for tag=off (no round-trip). */
  tag: string | null
  level: Level
  render?: MarkerRender
  /** "email" selects the email forms at low and mid. Default "token". */
  shape?: "token" | "email"
}

/** The core marker for a level, with no public parts. */
export function markerCore(kind: string, tag: string | null, level: Level): string {
  if (tag === null) return "[REDACTED]"
  if (level === "xhigh") return `[REDACTED:${tag}]`
  return `[REDACTED:${kind}:${tag}]`
}

/** Tail length kept at low: min(4, floor(len/16)). Under 16 chars, none. */
export function tailLength(len: number): number {
  return Math.min(4, Math.floor(len / 16))
}

/** Hidden chars that must stay between the public prefix and the tail. */
export const MIN_HIDDEN = 12

/**
 * Low tail for a random part of `randomLen` chars (value minus public prefix).
 * n = min(4, floor(randomLen/16)). No tail when fewer than 12 chars would stay hidden.
 */
export function lowTail(randomLen: number): number {
  const n = tailLength(randomLen)
  return n > 0 && randomLen - n >= MIN_HIDDEN ? n : 0
}

/** Short part: 4 chars or fewer show the first char only. */
function headOf(part: string, n: number): string {
  return part.length <= 4 ? part.slice(0, 1) : part.slice(0, n)
}

/** Email low form: `ja[...]@ex[...]le.com#<tag>`. Tag off drops the `#<tag>`. */
export function emailLow(email: string, tag: string | null): string {
  const at = email.lastIndexOf("@")
  if (at <= 0 || at === email.length - 1) return markerCore("email", tag, "high")
  const local = email.slice(0, at)
  const labels = email.slice(at + 1).split(".")
  const first = labels[0] as string
  const rest = labels.slice(1)
  const firstOut =
    first.length <= 4 ? `${first.slice(0, 1)}[...]` : `${first.slice(0, 2)}[...]${first.slice(-2)}`
  const domain = [firstOut, ...rest].join(".")
  const suffix = tag === null ? "" : `#${tag}`
  return `${headOf(local, 2)}[...]@${domain}${suffix}`
}

function renderPem(value: string, core: string): string {
  const lines = value.split("\n")
  const begin = lines[0] ?? ""
  let endIdx = lines.length - 1
  while (endIdx > 0 && (lines[endIdx] as string).trim() === "") endIdx--
  if (endIdx <= 0 || !begin.startsWith("-----BEGIN")) return core
  const end = lines[endIdx] as string
  const trailing = lines.slice(endIdx + 1).join("\n")
  return `${begin}\n${core}\n${end}${endIdx < lines.length - 1 ? `\n${trailing}` : ""}`
}

/** Build the replacement text for one value at one level. `off` returns the value. */
export function renderMarker(input: MarkerInput): string {
  const { value, kind, tag, level } = input
  const render = input.render ?? {}
  if (level === "off") return value
  const core = markerCore(kind, tag, level)
  if (level === "high" || level === "xhigh") return core

  if (input.shape === "email") {
    if (level === "low") return emailLow(value, tag)
    const at = value.lastIndexOf("@")
    return at > 0 ? `${core}${value.slice(at)}` : core
  }
  if (render.pem) return renderPem(value, core)

  const prefix =
    render.publicPrefix !== undefined && value.startsWith(render.publicPrefix)
      ? render.publicPrefix
      : ""
  if (level === "mid") return `${prefix}${core}`
  const n = render.keepTail ? lowTail(value.length - prefix.length) : 0
  const tail = n > 0 ? value.slice(-n) : ""
  return `${prefix}${core}${tail}`
}

/** Fixed marker samples for the marker-safety self-test. Tags are illustrative. */
export function markerSamples(kind: string): string[] {
  const tag = "1a2b3c4d"
  return [
    markerCore(kind, tag, "high"),
    markerCore(kind, tag, "xhigh"),
    "[REDACTED]",
    `[REDACTED:email:${tag}]@example.com`,
    emailLow("jane.doe@example.com", tag),
    "[REDACTED:unscanned:4194305]",
    "[REDACTED:error:1234]",
    "[REDACTED:filter-error:1234]",
  ]
}

export const LEVELS_ON: readonly Level[] = ["low", "mid", "high", "xhigh"]
