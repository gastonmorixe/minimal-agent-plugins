import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { pluginSideband } from "../../tests/support/sideband.ts"
import {
  fakeDisplay,
  noDisplay,
  realDisplaySideband,
  writePaste,
} from "../__fixtures__/display-sideband.ts"

import {
  expandPasteRefs,
  PASTE_CUT_MARKER,
  PASTE_DISPLAY_BYTES,
  PASTE_MAX_CHARS,
  PASTE_MISSING_MARKER,
} from "./paste.ts"

/** The real codec (`tests/support/sideband.ts`). */
const sb = await pluginSideband()

const SID = "ba0ad20f-0000-4000-8000-666ff6ccaa5b"
const URL =
  "https://linear.app/arcanums/issue/DEV-244/user-can-make-a-shared-project-view-only-for-a-team"

/** A paste ref of the real codec. */
function ref(id: string, body?: string): string {
  return sb.render("paste", {
    attrs: { id, bytes: 93, lines: 1 },
    ...(body === undefined ? {} : { body }),
  })
}

/** A fake display that gives `text` for each paste node. */
const shows = (text: string, extra: { truncated?: boolean } = {}) =>
  fakeDisplay(sb, () => ({ label: "paste", text, ...extra }))

describe("expandPasteRefs: the core display API", () => {
  test("a ref becomes the display text of its segment", () => {
    const fake = shows(URL)
    expect(expandPasteRefs(`status of ${ref("m23a7")} ?`, fake, SID)).toBe(`status of ${URL} ?`)
  })

  test("the call is full mode, with the sid, the byte cap and the paste kind only", () => {
    const fake = shows(URL)
    expandPasteRefs(`a ${ref("m23a7")} b`, fake, SID)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.opts).toEqual({
      mode: "full",
      sid: SID,
      maxBytes: PASTE_DISPLAY_BYTES,
      kinds: ["paste"],
    })
    expect(PASTE_DISPLAY_BYTES).toBe(8192)
  })

  test("missing: true gives the marker", () => {
    const fake = fakeDisplay(sb, () => ({ label: "paste", missing: true }))
    expect(expandPasteRefs(`see ${ref("m23a7")}`, fake, SID)).toBe(`see ${PASTE_MISSING_MARKER}`)
  })

  test("a display with no text (label only, for example no sid) gives the marker", () => {
    const fake = fakeDisplay(sb, () => ({ label: "paste" }))
    expect(expandPasteRefs(ref("m23a7"), fake, undefined)).toBe(PASTE_MISSING_MARKER)
  })

  test("a paste node with no display (a failed handler) gives the marker", () => {
    const fake = fakeDisplay(sb, () => undefined)
    expect(expandPasteRefs(`x ${ref("m23a7")} y`, fake, SID)).toBe(`x ${PASTE_MISSING_MARKER} y`)
  })

  test("a display that throws gives the marker", () => {
    const fake = shows(URL)
    fake.display = () => {
      throw new Error("boom")
    }
    expect(expandPasteRefs(ref("m23a7"), fake, SID)).toBe(PASTE_MISSING_MARKER)
  })

  test("a ref with a body keeps its body", () => {
    const fake = fakeDisplay(sb, () => ({ label: "paste" }))
    expect(expandPasteRefs(`a ${ref("m23a7", "inline body")} b`, fake, SID)).toBe("a inline body b")
  })

  test("a long paste keeps the head, then the cut marker", () => {
    const long = "漢".repeat(PASTE_MAX_CHARS + 50)
    expect(expandPasteRefs(ref("m23a7"), shows(long), SID)).toBe(
      `${"漢".repeat(PASTE_MAX_CHARS)}\n${PASTE_CUT_MARKER}`,
    )
  })

  test("truncated: true from core also gives the cut marker", () => {
    const out = expandPasteRefs(ref("m23a7"), shows("short head", { truncated: true }), SID)
    expect(out).toBe(`short head\n${PASTE_CUT_MARKER}`)
  })

  test("a paste of exactly the cap does not change", () => {
    const text = "a".repeat(PASTE_MAX_CHARS)
    expect(expandPasteRefs(ref("m23a7"), shows(text), SID)).toBe(text)
  })

  test("CRLF in the paste text becomes LF", () => {
    expect(expandPasteRefs(ref("m23a7"), shows("a\r\nb\rc"), SID)).toBe("a\nb\nc")
  })

  test("text with no ref does not change and calls no display", () => {
    const fake = shows(URL)
    expect(expandPasteRefs("plain text", fake, SID)).toBe("plain text")
    expect(fake.calls).toHaveLength(0)
  })

  test("a node of another kind stays as it is (the tag strip removes it later)", () => {
    const policy = sb.render("policy", { body: "secret rule" })
    const fake = shows(URL)
    expect(expandPasteRefs(`${policy} and ${ref("m23a7")}`, fake, SID)).toBe(`${policy} and ${URL}`)
  })

  test("a node segment of another kind gets its source text, not its label", () => {
    const policy = sb.render("policy", { body: "secret rule" })
    const fake = shows(URL)
    // A display that ignores `kinds` and shows the policy node too.
    const inner = fake.display
    fake.display = (text, opts) => {
      const { kinds: _k, ...rest } = opts
      return inner(text, rest)
    }
    const out = expandPasteRefs(`${policy} and ${ref("m23a7")}`, fake, SID)
    expect(out).toBe(`${policy} and ${URL}`)
    expect(out).not.toContain("label of policy")
  })
})

describe("expandPasteRefs: an old host with no display", () => {
  test("each paste ref gives the marker and no display call", () => {
    const old = noDisplay(sb)
    expect(expandPasteRefs(`a ${ref("m23a7")} b ${ref("zz999")}`, old, SID)).toBe(
      `a ${PASTE_MISSING_MARKER} b ${PASTE_MISSING_MARKER}`,
    )
  })
})

describe("expandPasteRefs: the real paste display handler", () => {
  const dir = mkdtempSync(join(tmpdir(), "ma-title-display-"))
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const real = realDisplaySideband(dir)

  test("a ref becomes the exact text of its file", async () => {
    writePaste(dir, SID, "m23a7", URL)
    expect(expandPasteRefs(`status of ${ref("m23a7")} ?`, await real, SID)).toBe(
      `status of ${URL} ?`,
    )
  })

  test("a missing file gives the marker", async () => {
    writePaste(dir, SID, "m23a7", URL)
    expect(expandPasteRefs(ref("qqqqq"), await real, SID)).toBe(PASTE_MISSING_MARKER)
  })

  test("a file of more than the byte cap gives the head and the cut marker", async () => {
    writePaste(dir, SID, "big01", "x".repeat(PASTE_DISPLAY_BYTES * 2))
    expect(expandPasteRefs(ref("big01"), await real, SID)).toBe(
      `${"x".repeat(PASTE_MAX_CHARS)}\n${PASTE_CUT_MARKER}`,
    )
  })

  test("a bad id or an unknown sid gives the marker", async () => {
    writePaste(dir, SID, "m23a7", URL)
    expect(expandPasteRefs(ref("../x"), await real, SID)).toBe(PASTE_MISSING_MARKER)
    expect(expandPasteRefs(ref("m23a7"), await real, "no-such-sid")).toBe(PASTE_MISSING_MARKER)
    expect(expandPasteRefs(ref("m23a7"), await real, undefined)).toBe(PASTE_MISSING_MARKER)
  })
})
