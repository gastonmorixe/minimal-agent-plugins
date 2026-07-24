/**
 * Connect unary client stub (application/proto POST).
 *
 * Phase 2.2 / 3 will implement HTTP/2 POST. Scaffold only — do not call live.
 *
 * @module llm/providers/cursor/connect/unary
 */

/**
 * POST a unary Connect protobuf body.
 * @throws always in Phase 2.0 scaffold
 */
export async function connectUnaryPost(_opts: {
  url: string
  headers: Record<string, string>
  body: Uint8Array
  signal?: AbortSignal
}): Promise<Uint8Array> {
  throw new Error(
    "cursor connect unary: not implemented (Phase 2.2 / 3 — HTTP/2 application/proto client)",
  )
}
