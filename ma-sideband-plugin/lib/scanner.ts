import { makeContext, parseAt } from "./parse.ts"
import type { ReadonlySidebandRegistry, SidebandNode, StreamScanner } from "./types.ts"

const OPEN_CAP = 1024
const BODY_CAP = 65536

/**
 * Make a streaming scanner. It fires onNode only for registered from-model
 * kinds. Other text passes through unchanged and in order. An opener split
 * across chunks is held until the next chunk.
 */
export function createScanner(registry: ReadonlySidebandRegistry): StreamScanner {
  let buf = ""
  let textCb: ((text: string) => void) | undefined
  let nodeCb: ((node: SidebandNode, raw: string) => void) | undefined

  const text = (t: string): void => {
    if (t.length > 0) textCb?.(t)
  }

  const pump = (final: boolean): void => {
    const ctx = makeContext(registry)
    const accept = (kind: string): boolean => ctx.kind(kind)?.direction === "from-model"
    let pos = 0
    while (pos < buf.length) {
      const idx = buf.indexOf("<", pos)
      if (idx < 0) {
        text(buf.slice(pos))
        pos = buf.length
        break
      }
      text(buf.slice(pos, idx))
      pos = idx
      const r = parseAt(buf, idx, ctx, accept)
      if (r.status === "node") {
        nodeCb?.(r.node, buf.slice(idx, r.end))
        pos = r.end
        continue
      }
      if (r.status === "incomplete") {
        if (final) {
          text(buf.slice(idx))
          pos = buf.length
          break
        }
        if (buf.length - idx <= (r.phase === "open" ? OPEN_CAP : BODY_CAP)) break
      }
      text("<")
      pos = idx + 1
    }
    buf = buf.slice(pos)
  }

  return {
    write(chunk: string): void {
      buf += chunk
      pump(false)
    },
    end(): void {
      pump(true)
      buf = ""
    },
    onText(cb): void {
      textCb = cb
    },
    onNode(cb): void {
      nodeCb = cb
    },
  }
}
