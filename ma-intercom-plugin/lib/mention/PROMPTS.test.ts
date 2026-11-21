import { describe, expect, it } from "bun:test"

import { NO_SIDEBAND } from "@minimal-agent/core/host/sideband"

import { pluginSideband } from "../../../tests/support/sideband.ts"

import { escapeXmlAttr, escapeXmlText, formatPeerMentionXml } from "./PROMPTS.ts"

const sb = await pluginSideband()

describe("formatPeerMentionXml", () => {
  it("includes name + sid and preserves the @body", () => {
    expect(
      formatPeerMentionXml(
        {
          name: "Michelle",
          sid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          body: "@Michelle",
        },
        sb,
      ),
    ).toBe(
      '<ma::intercom::peer name="Michelle" sid="a1b2c3d4-e5f6-7890-abcd-ef1234567890">@Michelle</ma::intercom::peer>',
    )
  })

  it("omits name when absent", () => {
    expect(
      formatPeerMentionXml(
        {
          sid: "bd94a4be-af3a-4bc5-a18c-993b26a86682",
          body: "@bd94a4be",
        },
        sb,
      ),
    ).toBe(
      '<ma::intercom::peer sid="bd94a4be-af3a-4bc5-a18c-993b26a86682">@bd94a4be</ma::intercom::peer>',
    )
  })

  it("escapes attr and body specials", () => {
    expect(
      formatPeerMentionXml(
        {
          name: 'A&B "C"',
          sid: "x<y>",
          body: "@A&B",
        },
        sb,
      ),
    ).toBe(
      '<ma::intercom::peer name="A&amp;B &quot;C&quot;" sid="x&lt;y&gt;">@A&amp;B</ma::intercom::peer>',
    )
  })
})

describe("formatPeerMentionXml with no sideband codec (NO_SIDEBAND)", () => {
  it("renders no tag", () => {
    expect(formatPeerMentionXml({ sid: "s1", body: "@s1" }, NO_SIDEBAND)).toBe("")
    expect(formatPeerMentionXml({ sid: "s1", body: "@s1" }, undefined)).toBe("")
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
