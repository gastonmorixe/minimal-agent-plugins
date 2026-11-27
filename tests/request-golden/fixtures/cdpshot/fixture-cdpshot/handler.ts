// Test fixture for the request golden harness. Not a real plugin.
import { runWithDeps } from "../../../../../ma-chrome-cdp-plugin/handlers/chrome_cdp.ts"
import type { TUIContext, TUIResult } from "../../../../../ma-chrome-cdp-plugin/lib/types.ts"

/** Fixed 24 byte PNG header (16x16), the same bytes as the image-read golden. */
function pngBytes(): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  b[19] = 16
  b[23] = 16
  return b
}

/**
 * Run the real ChromeCDP handler with a fake daemon: no socket, no spawn, no
 * lease file. A `send` gives the CDP result of `Page.captureScreenshot`.
 */
export default function handler(ctx: TUIContext): Promise<TUIResult> {
  const data = Buffer.from(pngBytes()).toString("base64")
  return runWithDeps(ctx, {
    writeLease: () => {},
    ensure: async () => true,
    spawnDaemon: () => {},
    socketFetch: async (route) =>
      route === "ping"
        ? { status: 200, body: { ok: true } }
        : { status: 200, body: { result: { data }, sessionId: "golden-session" } },
  })
}
