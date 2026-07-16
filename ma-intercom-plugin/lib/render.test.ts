/**
 * Tests for the arrival-notice renderers. These lock the bug fix: the human
 * terminal surface must NOT html-escape peer text (the `&lt;/&gt;` regression),
 * while still stripping smuggled escape/control sequences.
 *
 * @module lib/render.test
 */

import { describe, expect, test } from "bun:test"

import type { Envelope } from "./envelope.ts"
import type { Liveness } from "./liveness.ts"
import type { PresenceRecord } from "./presence.ts"
import {
  arrivalLabel,
  type InspectBundle,
  peerLabel,
  peerLabelDisplay,
  renderArrivalLines,
  renderArrivalText,
  renderInspectText,
  renderRosterDisplay,
  renderRosterText,
  renderSendDisplay,
  renderSendHeader,
  toArrivalNotice,
  toArrivalNotices,
} from "./render.ts"
import type { RosterCounts, RosterRow } from "./roster.ts"

/** Strip ANSI SGR so assertions read against plain text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI for assertions.
const noAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

function env(over: Partial<Envelope> = {}): Envelope {
  return {
    id: "id-1",
    kind: "message",
    body: "hello",
    ts: "2026-06-25T13:00:04.805Z",
    from: { sid: "s-aaaaaa", short: "aaaaaa", model: "opus", cwd: "/x/proj" },
    to: "bbbbbb",
    scope: "bbbbbb",
    ...over,
  } as Envelope
}

describe("arrivalLabel", () => {
  test("singular vs plural", () => {
    expect(arrivalLabel(1)).toBe("1 new message")
    expect(arrivalLabel(3)).toBe("3 new messages")
  })
})

describe("peerLabel", () => {
  test("Name (short) when named, short alone when not", () => {
    expect(peerLabel("3782589f", "Sergio")).toBe("Sergio (3782589f)")
    expect(peerLabel("3782589f")).toBe("3782589f")
    expect(peerLabel("3782589f", "")).toBe("3782589f")
    expect(peerLabel("", "Sergio")).toBe("Sergio")
  })

  test("display form keeps short dimmed in parens", () => {
    const out = noAnsi(peerLabelDisplay("3782589f", "Sergio"))
    expect(out).toBe("Sergio (3782589f)")
  })
})

describe("renderSendHeader / renderSendDisplay", () => {
  test("send header is destination only (no 'message' word)", () => {
    const h = noAnsi(
      renderSendHeader({
        kind: "message",
        scope: "3782589f",
        delivered: [{ short: "3782589f", sid: "3782589f-full", name: "Sergio" }],
        body: "hi",
      }),
    )
    expect(h).toBe("→ Sergio (3782589f)")
    expect(h).not.toContain("message")
    expect(h).not.toContain("◇")
  })

  test("interrupt keeps urgency word, still destination-first", () => {
    const h = noAnsi(
      renderSendHeader({
        kind: "interrupt",
        scope: "3782589f",
        delivered: [{ short: "3782589f", sid: "x", name: "Sergio" }],
        body: "stop",
      }),
    )
    expect(h).toContain("interrupt")
    expect(h).toContain("→")
    expect(h).toContain("Sergio (3782589f)")
    expect(h).not.toContain("message")
  })

  test("send display is the body only (no recipient glyph), trailing pad only", () => {
    const d = noAnsi(
      renderSendDisplay({
        kind: "message",
        scope: "3782589f",
        delivered: [{ short: "3782589f", sid: "x" }],
        body: "hello there",
      }),
    )
    // Host already draws a blank │ after the header — no leading pad.
    expect(d.startsWith("\n")).toBe(false)
    expect(d.startsWith("hello there")).toBe(true)
    expect(d.endsWith("\n")).toBe(true)
    expect(d).not.toContain("◇")
    expect(d).not.toContain("3782589f")
  })

  test("broadcast header shows scope + peer count", () => {
    const h = noAnsi(
      renderSendHeader({
        kind: "message",
        scope: "all",
        delivered: [
          { short: "aaaa", sid: "a" },
          { short: "bbbb", sid: "b" },
        ],
        body: "hi all",
      }),
    )
    expect(h).toContain("→")
    expect(h).toContain("all")
    expect(h).toContain("2 peers")
  })
})

describe("renderArrivalLines (human terminal)", () => {
  test("does NOT html-escape angle brackets in the body (the &lt; bug)", () => {
    const lines = renderArrivalLines(env({ body: "use <ma::foo> and a < b > c" })).map(noAnsi)
    const joined = lines.join("\n")
    expect(joined).toContain("use <ma::foo> and a < b > c")
    expect(joined).not.toContain("&lt;")
    expect(joined).not.toContain("&gt;")
    expect(joined).not.toContain("‹ma::")
  })

  test("returns bare rows: no box frame glyphs (host owns chrome)", () => {
    const lines = renderArrivalLines(env())
    for (const l of lines) {
      expect(l).not.toContain("╭")
      expect(l).not.toContain("│")
      expect(l).not.toContain("╰")
    }
  })

  test("strips smuggled ANSI/control sequences from peer body", () => {
    const evil = "safe\x1b[31mRED\x1b[0m\x1b]0;title\x07tail"
    const out = noAnsi(renderArrivalLines(env({ body: evil })).join("\n"))
    expect(out).toContain("safe")
    expect(out).toContain("RED")
    expect(out).toContain("tail")
    expect(out).not.toContain("\x1b")
    expect(out).not.toContain("\x07")
  })

  test("body is message text only — who/when live in header/footer", () => {
    const lines = renderArrivalLines(
      env({
        kind: "interrupt",
        body: "hi from sergio",
        from: {
          sid: "s-aaaaaa",
          short: "aaaaaa",
          model: "opus",
          cwd: "/x/proj",
          pid: 1,
          host: "h",
          name: "Sergio",
        },
      }),
    ).map(noAnsi)
    expect(lines).toEqual(["hi from sergio"])
  })
})

describe("renderArrivalLines bare-row contract (host frames per-row)", () => {
  // The host's renderCommandNoticeBlock prefixes a "│ " gutter to EACH row it
  // receives and wraps to terminal width itself. That only holds if every row we
  // hand it is a single physical line: an embedded "\n" would slip past the
  // per-row gutter and tear the frame (the row after the newline gets no gutter).
  // And we must never emit our own frame glyphs — the host owns the chrome.

  test("every row is a single physical line (no embedded newline)", () => {
    const rows = renderArrivalLines(env({ body: "line one\nline two\nline three" }))
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r).not.toContain("\n")
      expect(r).not.toContain("\r")
    }
  })

  test("a multi-line body is split into one row per source line", () => {
    const rows = renderArrivalLines(env({ body: "a\nb\nc" })).map(noAnsi)
    expect(rows).toEqual(["a", "b", "c"])
  })

  test("no row carries a frame glyph (╭ │ ╰) — host draws the box", () => {
    const rows = renderArrivalLines(env({ kind: "interrupt", body: "x\ny" }))
    for (const r of rows) {
      expect(r).not.toContain("╭")
      expect(r).not.toContain("│")
      expect(r).not.toContain("╰")
    }
  })

  test("a very long unbreakable token stays one row (host hard-breaks at render)", () => {
    // The plugin must NOT pre-wrap: it can't know the reader's width. A 200-char
    // path with no spaces stays a single row here; the host wordWrap hard-breaks
    // it (and re-gutters each fragment) at paint time.
    const longTok = `/Users/x/${"a".repeat(200)}/sid.blobs/id.raw`
    const rows = renderArrivalLines(env({ body: longTok }))
    const bodyRows = rows.filter((r) => noAnsi(r).includes("a".repeat(50)))
    expect(bodyRows.length).toBe(1)
    expect(bodyRows[0]).not.toContain("\n")
  })
})

describe("toArrivalNotice (the notification.emit payload contract)", () => {
  test("assembles the full payload: source, framed block, plain text", () => {
    const e = env({
      body: "hi",
      from: {
        sid: "s-aaaaaa",
        short: "aaaaaa",
        model: "opus",
        cwd: "/x/proj",
        pid: 1,
        host: "h",
        name: "Sergio",
      },
    })
    const n = toArrivalNotice(e)
    expect(n.source).toBe("intercom")
    expect(n.block.icon).toBe("↓")
    expect(n.block.title).toBe("Intercom") // capitalized, survives host coerceNoticeBlock drop-guard
    expect(n.block.info).toBe("from Sergio (aaaaaa)")
    expect(n.block.footer).toBe("opus")
    expect(n.block.timestamp).toBe("13:00:04")
    expect(n.block.color).toBe("magenta") // real host palette key, not the gold fallback
    expect(n.block.body).toEqual(["hi"])
    expect(n.text).toBe(renderArrivalText(e))
  })

  test("block.body is message-only and carries no frame glyphs (host owns chrome)", () => {
    const n = toArrivalNotice(env({ kind: "interrupt", body: "a\nb" }))
    expect(n.block.body).toEqual(["a", "b"])
    for (const r of n.block.body) {
      expect(r).not.toContain("╭")
      expect(r).not.toContain("│")
      expect(r).not.toContain("╰")
      expect(r).not.toContain("\n")
    }
  })

  test("interrupt puts palette-red urgency in the title; info stays from-who only", () => {
    const irq = toArrivalNotice(
      env({
        kind: "interrupt",
        from: { ...env().from, short: "aaaaaa", name: "Sergio" },
      }),
    )
    expect(irq.block.info).toBe("from Sergio (aaaaaa)")
    // Title carries the red word (host dims info, so red would wash out there).
    expect(noAnsi(irq.block.title)).toBe("Intercom interrupt")
    expect(irq.block.title).not.toBe(noAnsi(irq.block.title)) // has ANSI
    expect(irq.block.title).toContain("interrupt")
  })

  test("toArrivalNotices emits one toast per envelope", () => {
    const notices = toArrivalNotices([
      env({ id: "a", from: { ...env().from, short: "aaaaaa", name: "Sergio" } }),
      env({ id: "b", from: { ...env().from, short: "bbbbbb", name: "Karen" } }),
    ])
    expect(notices).toHaveLength(2)
    expect(notices[0]!.block.info).toBe("from Sergio (aaaaaa)")
    expect(notices[1]!.block.info).toBe("from Karen (bbbbbb)")
  })
})

describe("renderArrivalText (persistence)", () => {
  test("plain, no ANSI, no html-escape, carries who + body", () => {
    const text = renderArrivalText(
      env({
        body: "x < y",
        from: { ...env().from, short: "aaaaaa", name: "Sergio", model: "opus" },
      }),
    )
    expect(text).toBe(noAnsi(text)) // already plain
    expect(text).toContain("from Sergio (aaaaaa)")
    expect(text).toContain("x < y")
    expect(text).toContain("opus")
    expect(text).not.toContain("&lt;")
  })
})

describe("renderInspectText — name line", () => {
  function rec(over: Partial<PresenceRecord> = {}): PresenceRecord {
    return {
      v: 1,
      sid: "939749b9-ff79-492b-8951-f73112fcb519",
      short: "939749b9",
      pid: 69701,
      host: "macbookpro.home.arpa",
      ts: "2026-06-26T23:50:02.000Z",
      startedAt: "2026-06-26T23:50:00.000Z",
      agentVersion: "0.1.0",
      model: "claude-opus-4-8",
      cwd: "/Users/gaston/Projects/minimal-agent",
      projectRoot: "/Users/gaston/Projects/minimal-agent",
      phase: "idle",
      activity: null,
      ...over,
    }
  }
  const liveness: Liveness = {
    status: "online",
    phase: "idle",
    pid: 69701,
    since: "2026-06-26T23:50:00.000Z",
    ageMs: 1000,
  }

  test("header uses Name (short) when set, with sid on its own line", () => {
    const out = renderInspectText({ record: rec({ name: "Camila" }), liveness } as InspectBundle)
    expect(out).toContain("Peer Camila (939749b9)")
    expect(out).toContain("  sid: 939749b9-ff79-492b-8951-f73112fcb519")
    expect(out.indexOf("Peer Camila")).toBeLessThan(out.indexOf("  liveness:"))
  })

  test("header is short alone when the peer carries no name", () => {
    const out = renderInspectText({ record: rec(), liveness } as InspectBundle)
    expect(out).toContain("Peer 939749b9")
    expect(out).not.toContain("Peer 939749b9 (")
    expect(out).toContain("  sid:")
  })
})

describe("renderRoster — agent name in the list", () => {
  function rec(over: Partial<PresenceRecord> = {}): PresenceRecord {
    return {
      v: 1,
      sid: "939749b9-ff79-492b-8951-f73112fcb519",
      short: "939749b9",
      pid: 69701,
      host: "macbookpro.home.arpa",
      ts: "2026-06-26T23:50:02.000Z",
      startedAt: "2026-06-26T23:50:00.000Z",
      agentVersion: "0.1.0",
      model: "claude-opus-4-8",
      cwd: "/Users/gaston/Projects/minimal-agent",
      projectRoot: "/Users/gaston/Projects/minimal-agent",
      phase: "idle",
      activity: null,
      ...over,
    }
  }
  function row(over: Partial<PresenceRecord> = {}): RosterRow {
    return {
      record: rec(over),
      liveness: {
        status: "online",
        phase: "idle",
        pid: 69701,
        since: "2026-06-26T23:50:00.000Z",
        ageMs: 1000,
      },
      isSelf: false,
      isRemote: false,
    }
  }
  const counts: RosterCounts = { total: 1, online: 0, busy: 0, idle: 1, other: 0 }

  test("text roster shows Name (short) when set", () => {
    const out = renderRosterText([row({ name: "Jerry" })], counts)
    expect(out).toContain(`Jerry (939749b9)`)
  })

  test("text roster is short alone when the peer is unnamed", () => {
    const out = noAnsi(renderRosterText([row()], counts))
    expect(out).toContain("939749b9")
    expect(out).not.toContain("Jerry")
    expect(out).not.toContain(`"`)
  })

  test("display roster shows Name (short) when set", () => {
    const out = noAnsi(renderRosterDisplay([row({ name: "Jerry" })]))
    expect(out).toContain(`Jerry (939749b9)`)
  })
})
