/**
 * ACP side of the paste-ref contract (paste plugin v3, PLAN item I7).
 *
 * ACP has no paste input. But a paste ref can still reach ACP: a client can
 * type it, or a replay can send it again. The paste plugin expands a ref in
 * its `message.willSend` hook in core. This fake runtime does not run that
 * hook. Thus this test checks only the ACP side of the contract: host-mode
 * sends the prompt text to the runtime with no change, and a ref with an
 * unknown id does not halt the turn or break the session.
 *
 * @module host-mode.paste-ref.test
 */

import { describe, expect, it } from "bun:test"

import { pluginSideband } from "../tests/support/sideband.ts"

import { createFakeRuntime } from "./__fixtures__/fake-runtime.ts"
import { openInMemorySession } from "./__fixtures__/in-memory-host.ts"

const SB = await pluginSideband()

/** A self-closing paste ref, from the real codec. No paste file has this id. */
const REF = SB.render("paste", { attrs: { id: "zzzzz", bytes: 9, lines: 1 } })

const END_TURN = {
  stopReason: "end_turn",
  usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
}

type Host = Awaited<ReturnType<typeof openInMemorySession>>

/** Send one text prompt and wait for its reply. */
const prompt = (h: Host, id: number, t: string) => {
  h.send({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId: h.sessionId, prompt: [{ type: "text", text: t }] },
  })
  return h.reply(id)
}

describe("session/prompt with a paste ref (unknown id)", () => {
  it("sends the text with the ref unchanged, ends the turn, and the next prompt works", async () => {
    const rt = createFakeRuntime()
    const h = await openInMemorySession(rt)
    const t = `see ${REF} please`
    expect(REF).toContain('id="zzzzz"')

    const r = await prompt(h, 3, t)
    expect(r.error).toBeUndefined()
    expect(r.result).toEqual(END_TURN)
    expect(rt.prompts).toEqual([t])

    const r2 = await prompt(h, 4, "next")
    expect(r2.error).toBeUndefined()
    expect(r2.result).toEqual(END_TURN)
    expect(rt.prompts).toEqual([t, "next"])
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("sends a prompt that is only the ref unchanged, and ends the turn", async () => {
    const rt = createFakeRuntime()
    const h = await openInMemorySession(rt)
    const r = await prompt(h, 3, REF)
    expect(r.error).toBeUndefined()
    expect(r.result).toEqual(END_TURN)
    expect(rt.prompts).toEqual([REF])
    h.end()
    expect(await h.exit).toBe(0)
  })
})
