/**
 * Citation-marker stripping for OpenAI text output.
 *
 * The fixture `responses-citation-marker.sse` keeps the delta split of a live
 * capture: the marker arrives in 12 deltas, after a delta that is one space.
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"

import { collect, replayResponses } from "../openai.test-helpers.ts"

import {
  CitationMarkerStripper,
  MAX_MARKER_CHARS,
  stripCitationMarkers,
  stripCitationMarkersFromText,
} from "./citation-markers.ts"

const OPEN = "\uE200"
const SEP = "\uE202"
const CLOSE = "\uE201"
const MARKER = `${OPEN}cite${SEP}turn0search0${SEP}turn0search1${CLOSE}`

/** Feed `deltas` one by one, then flush. */
function run(deltas: string[]): string {
  const stripper = new CitationMarkerStripper()
  return deltas.map((d) => stripper.push(d)).join("") + stripper.flush()
}

async function* fromArray(events: CanonicalEvent[]): AsyncIterable<CanonicalEvent> {
  for (const ev of events) yield ev
}

function textOf(events: CanonicalEvent[]): string {
  return events
    .filter((e): e is Extract<CanonicalEvent, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("")
}

describe("CitationMarkerStripper", () => {
  it("drops a complete marker and the blank before it", () => {
    expect(run([`Done. ${MARKER}`])).toBe("Done.")
  })

  it("keeps the text after a marker", () => {
    expect(run([`One ${MARKER} two ${MARKER}\nthree`])).toBe("One two\nthree")
  })

  it("drops a marker split at every character", () => {
    expect(run(`Done. ${MARKER} More.`.split(""))).toBe("Done. More.")
  })

  it("gives the same result for every two-part split", () => {
    const whole = `A ${MARKER} B  ${MARKER}`
    const expected = run([whole])
    expect(expected).toBe("A B")
    for (let i = 0; i <= whole.length; i++) {
      expect(run([whole.slice(0, i), whole.slice(i)])).toBe(expected)
    }
  })

  it("drops other marker kinds with the same grammar", () => {
    expect(run([`See${OPEN}filecite${SEP}turn0file2${CLOSE}.`])).toBe("See.")
  })

  it("emits text before a marker without waiting for the marker to close", () => {
    const stripper = new CitationMarkerStripper()
    expect(stripper.push(`Done. ${OPEN}cite${SEP}turn0`)).toBe("Done.")
    expect(stripper.push(`search0${CLOSE}`)).toBe("")
    expect(stripper.flush()).toBe("")
  })

  it("keeps trailing blanks when no marker follows", () => {
    expect(run(["a ", "b  "])).toBe("a b  ")
  })

  it("keeps a lone open character (a Nerd Font glyph)", () => {
    expect(run([`icon ${OPEN} here`])).toBe(`icon ${OPEN} here`)
    expect(run([`icon ${OPEN}`])).toBe(`icon ${OPEN}`)
  })

  it("keeps an unfinished marker when the block ends", () => {
    const text = `Done. ${OPEN}cite${SEP}turn0search0`
    expect(run(text.split(""))).toBe(text)
  })

  it("keeps a marker with no reference", () => {
    expect(run([`x ${OPEN}cite${CLOSE} y`])).toBe(`x ${OPEN}cite${CLOSE} y`)
  })

  it("keeps a marker that spans a line break", () => {
    const text = `x ${OPEN}cite${SEP}turn0\nsearch0${CLOSE} y`
    expect(run(text.split(""))).toBe(text)
  })

  it("stops holding text once the marker is too long", () => {
    const stripper = new CitationMarkerStripper()
    const long = `${OPEN}cite${SEP}${"a".repeat(100)}${SEP}${"b".repeat(100)}${SEP}${"c".repeat(100)}`
    expect(long.length).toBeGreaterThan(MAX_MARKER_CHARS)
    expect(stripper.push(long)).toBe(long)
  })

  it("drops a real marker that follows a lone open character", () => {
    expect(run([`${OPEN} ${MARKER}`])).toBe(OPEN)
  })
})

describe("stripCitationMarkersFromText", () => {
  it("returns marker-free text unchanged", () => {
    expect(stripCitationMarkersFromText("plain  ")).toBe("plain  ")
  })

  it("strips markers from a whole string", () => {
    expect(stripCitationMarkersFromText(`Done. ${MARKER}`)).toBe("Done.")
  })
})

describe("stripCitationMarkers (canonical events)", () => {
  it("strips the marker from a replayed live delta split", async () => {
    const raw = await replayResponses("responses-citation-marker.sse")
    // The translator itself keeps the marker: the strip is a separate step.
    expect(textOf(raw)).toContain(MARKER)

    const events = await collect(stripCitationMarkers(fromArray(raw)))
    expect(textOf(events)).toBe("The project has a public site.")
    const stop = events.find((e) => e.type === "text_stop")
    expect(stop).toMatchObject({ finalText: "The project has a public site." })
    expect(JSON.stringify(events)).not.toMatch(/[\uE200-\uE202]/)
  })

  it("keeps every other event, in order", async () => {
    const raw = await replayResponses("responses-citation-marker.sse")
    const events = await collect(stripCitationMarkers(fromArray(raw)))
    const kinds = (list: CanonicalEvent[]) =>
      list.filter((e) => e.type !== "text_delta").map((e) => e.type)
    expect(kinds(events)).toEqual(kinds(raw))
  })

  it("leaves a marker-free stream unchanged", async () => {
    const raw = await replayResponses("responses-pong.sse")
    const events = await collect(stripCitationMarkers(fromArray(raw)))
    expect(textOf(events)).toBe(textOf(raw))
    expect(events.map((e) => e.type)).toEqual(raw.map((e) => e.type))
  })

  it("flushes an unfinished marker before text_stop", async () => {
    const events = await collect(
      stripCitationMarkers(
        fromArray([
          { type: "text_start", index: 0 },
          { type: "text_delta", index: 0, text: `Hi ${OPEN}cite` },
          { type: "text_stop", index: 0 },
        ]),
      ),
    )
    expect(events.map((e) => e.type)).toEqual([
      "text_start",
      "text_delta",
      "text_delta",
      "text_stop",
    ])
    expect(textOf(events)).toBe(`Hi ${OPEN}cite`)
  })

  it("flushes held text when the stream ends with no text_stop", async () => {
    const error: CanonicalEvent = {
      type: "stream_error",
      retryable: true,
      category: "api",
      upstreamType: "stream_closed_without_terminal",
    }
    const events = await collect(
      stripCitationMarkers(
        fromArray([
          { type: "text_start", index: 0 },
          { type: "text_delta", index: 0, text: "partial " },
          error,
        ]),
      ),
    )
    expect(textOf(events)).toBe("partial ")
    expect(events.at(-1)?.type).toBe("stream_error")
  })

  it("does not touch thinking or tool input", async () => {
    const input: CanonicalEvent[] = [
      { type: "thinking_start", index: 0 },
      { type: "thinking_delta", index: 0, text: MARKER },
      { type: "thinking_stop", index: 0 },
      { type: "tool_use_start", index: 1, id: "call_1", name: "WebSearch" },
      { type: "tool_use_input_delta", index: 1, partialJson: MARKER },
      { type: "tool_use_stop", index: 1, input: { query: MARKER } },
    ]
    expect(await collect(stripCitationMarkers(fromArray(input)))).toEqual(input)
  })
})
