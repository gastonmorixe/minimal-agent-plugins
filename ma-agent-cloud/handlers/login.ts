/**
 * `CloudLogin` — start the device-authorization login against the cloud backend.
 *
 * The device grant is inherently two-phase: we get a `user_code` + URL the human
 * must approve in a browser, then poll until they do. A tool call returns once,
 * so this handler:
 *   1. requests the device code,
 *   2. returns it to the user with the verification URL to approve, AND
 *   3. polls to completion within a bounded budget, persisting the token on
 *      success.
 *
 * In practice the user reads the printed code, approves in their browser, and the
 * same call's polling loop catches the approval and saves the token. If approval
 * takes longer than the budget, the user re-runs `CloudStatus` (which is idle) or
 * `CloudLogin` again — the device code is reusable until it expires.
 *
 * @module handlers/login
 */

import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { beginLogin, cloudConfig, completeLogin } from "../lib/login.ts"

/** Tool handler for `CloudLogin`. */
export default async function cloudLogin(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "CloudLogin: unexpected trigger", is_error: true }
  }
  const cfg = cloudConfig(ctx.env)

  // Phase 1: get the code to show the user.
  const begun = await beginLogin(cfg)
  if (!begun.ok) {
    return {
      kind: "tool_result",
      content: `CloudLogin: could not start login against ${cfg.baseUrl} — ${begun.reason}. Is the backend running? Override the URL with MINIMAL_AGENT_CLOUD_URL.`,
      is_error: true,
    }
  }
  const code = begun.value
  const approveUrl = code.verification_uri_complete ?? code.verification_uri

  // Phase 2: poll to completion. completeLogin respects the device code's own
  // expires_in as the deadline; the user approving in their browser resolves it.
  const done = await completeLogin(cfg, code, ctx.env)
  if (!done.ok) {
    // Most common: the budget elapsed before approval. Show the code so the user
    // can still approve and re-run.
    return {
      kind: "tool_result",
      content:
        `CloudLogin: started but not completed — ${done.reason}.\n` +
        `To finish: open ${approveUrl} and enter code ${code.user_code}, then run CloudLogin again.`,
      is_error: true,
      displayHeader: `☁ login · code ${code.user_code}`,
    }
  }

  const who = done.value.userId ? ` as ${done.value.userId}` : ""
  return {
    kind: "tool_result",
    content: `CloudLogin: logged in${who}. Token saved; cloud features are now enabled. Run CloudStatus to see flags.`,
    displayHeader: `☁ logged in`,
  }
}
