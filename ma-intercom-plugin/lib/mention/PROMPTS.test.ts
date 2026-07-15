import { describe, expect, it } from "bun:test"

import { escapeXmlAttr, escapeXmlText, formatPeerMentionXml } from "./PROMPTS.ts"

describe("formatPeerMentionXml", () => {
  it("includes name + sid and preserves the @body", () => {
    expect(
      formatPeerMentionXml({
        name: "Michelle",
        sid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        body: "@Michelle",
      }),
    ).toBe(
      '<ma::intercom::peer name="Michelle" sid="a1b2c3d4-e5f6-7890-abcd-ef1234567890">@Michelle</ma::intercom::peer>',
    )
  })

  it("omits name when absent", () => {
    expect(
      formatPeerMentionXml({
        sid: "7288e8a4-0000-4000-8000-6f07826425da",
        body: "@7288e8a4",
      }),
    ).toBe(
      '<ma::intercom::peer sid="7288e8a4-0000-4000-8000-6f07826425da">@7288e8a4</ma::intercom::peer>',
    )
  })

  it("escapes attr and body specials", () => {
    expect(
      formatPeerMentionXml({
        name: 'A&B "C"',
        sid: "x<y>",
        body: "@A&B",
      }),
    ).toBe(
      '<ma::intercom::peer name="A&amp;B &quot;C&quot;" sid="x&lt;y&gt;">@A&amp;B</ma::intercom::peer>',
    )
  })
})

describe("escapeXmlAttr / escapeXmlText", () => {
  it("escapes the five entities used in attrs", () => {
    expect(escapeXmlAttr(`a&b"c<d>e`)).toBe("a&amp;b&quot;c&lt;d&gt;e")
  })

  it("escapes text-node specials", () => {
    expect(escapeXmlText("a&b<c>")).toBe("a&amp;b&lt;c&gt;")
  })
})
