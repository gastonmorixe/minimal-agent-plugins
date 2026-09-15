/**
 * `CloudStatus` — report the cloud connector state, and (idempotently) ensure
 * the remote transport is registered into the host registry.
 *
 * This handler is also the plugin's de-facto registration trigger today: a
 * tool/inline handler is the only context the loader currently threads `ctx.host`
 * into (see register.ts for the boot-hook gap note), so registering here means the
 * transport is in the registry from this tool's first call onward. Registration is
 * idempotent (last-write-wins per id), so repeated calls are harmless.
 *
 * @module handlers/status
 */

import { currentFlags, isEnabled } from "../lib/feature-flags.ts"
import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { cloudConfig } from "../lib/login.ts"
import { registerTransport } from "../lib/register.ts"
import { loadAuth } from "../lib/token-store.ts"

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
}

/** Tool handler for `CloudStatus`. */
export default async function cloudStatus(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "CloudStatus: unexpected trigger", is_error: true }
  }
  const asJson = str(ctx.trigger.input.format) === "json"

  // Ensure the remote transport is registered (idempotent). Degrades gracefully
  // when the capability isn't granted (older core / capability not declared).
  const reg = registerTransport(ctx.host)
  const flags = currentFlags(ctx.env)
  const auth = loadAuth(ctx.env)
  const cfg = cloudConfig(ctx.env)

  const registered = reg.ok
  const transportId = reg.ok ? reg.transportId : null
  const cloudEnabled = isEnabled(flags, "cloudEnabled")
  const loggedIn = auth !== null

  if (asJson) {
    return {
      kind: "tool_result",
      content: JSON.stringify(
        {
          cloudEnabled,
          loggedIn,
          ...(auth?.userId ? { userId: auth.userId } : {}),
          baseUrl: cfg.baseUrl,
          flags,
          transport: { registered, id: transportId, note: reg.ok ? undefined : reg.reason },
        },
        null,
        2,
      ),
    }
  }

  const lines: string[] = []
  lines.push(`cloud: ${cloudEnabled ? "enabled" : "disabled (not logged in)"}`)
  lines.push(
    `  account: ${loggedIn ? `logged in${auth?.userId ? ` as ${auth.userId}` : ""}` : "not logged in — run CloudLogin"}`,
  )
  lines.push(`  backend: ${cfg.baseUrl}`)
  lines.push(
    `  flags: ${Object.entries(flags)
      .map(([k, v]) => `${k}=${v}`)
      .join(" · ")}`,
  )
  if (registered) {
    lines.push(
      `  transport: "${transportId}" registered in host transport registry${reg.ok && reg.alreadyPresent ? " (already present)" : ""}`,
    )
  } else {
    lines.push(`  transport: NOT registered — ${reg.ok ? "" : reg.reason}`)
  }
  lines.push(
    `  (the remote transport's network methods are still a stub until the WS layer lands; login + token are real)`,
  )

  return { kind: "tool_result", content: lines.join("\n") }
}
