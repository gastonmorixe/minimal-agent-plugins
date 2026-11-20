/**
 * Contract: the title plugin event `title.saved` and the intercom footer slot.
 *
 * The title plugin emits `title.saved` after it wrote a title. The CLI
 * scheduler runs a live-area slot again when the slot names the event in
 * `refreshOn`. The intercom slot `intercom_beat` paints the title in the
 * footer. The two plugins do not import each other, so the event name is a
 * string contract. This test fails when one side changes the name alone.
 *
 * @module tests/title-saved-contract
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { TITLE_SAVED_EVENT } from "../ma-title-plugin/handlers/on_prompt_submitted.ts"

const ROOT = join(import.meta.dir, "..")

/** The fields of a manifest live-area slot that this contract reads. */
interface SlotView {
  id: string
  position?: string
  refreshMs?: number
  refreshOn?: string[]
}

function intercomSlot(): SlotView | undefined {
  const text = readFileSync(join(ROOT, "ma-intercom-plugin", "manifest.json"), "utf-8")
  const manifest = JSON.parse(text) as { ui?: { liveAreaSlots?: SlotView[] } }
  return manifest.ui?.liveAreaSlots?.find((s) => s.id === "intercom_beat")
}

describe("title.saved contract: title plugin and intercom footer", () => {
  it("the event keeps its wire name", () => {
    expect(TITLE_SAVED_EVENT).toBe("title.saved")
  })

  it("the intercom footer slot runs again on the title event", () => {
    const slot = intercomSlot()
    expect(slot).toBeDefined()
    expect(slot?.position).toBe("footer")
    expect(slot?.refreshOn).toContain(TITLE_SAVED_EVENT)
  })

  it("the slot keeps its timer: a resumed session has a title but sends no event", () => {
    expect(typeof intercomSlot()?.refreshMs).toBe("number")
  })
})
