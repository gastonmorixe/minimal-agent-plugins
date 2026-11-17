/**
 * Function-call arguments with no argument delta.
 *
 * The Responses backend can send a call's arguments only on
 * `response.function_call_arguments.done` and `response.output_item.done`,
 * with zero `response.function_call_arguments.delta` events. It does this
 * often for parallel calls. The translator must then send the full arguments
 * as one `tool_use_input_delta`, or a consumer that builds the input from
 * deltas runs the tool with `{}` (research
 * 2026-11-17-session-1df63fe1-tool-input-loss, net-dbg attempt 002).
 */
import { describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"

import { type OpenAIResponsesEvent, translateOpenAIResponsesStream } from "./response-stream.ts"

async function translate(events: object[]): Promise<CanonicalEvent[]> {
  async function* src(): AsyncIterable<OpenAIResponsesEvent> {
    for (const e of events) yield e as OpenAIResponsesEvent
  }
  const out: CanonicalEvent[] = []
  for await (const e of translateOpenAIResponsesStream(src())) out.push(e)
  return out
}

/** Wire events of one call. `deltas` are the argument chunks to stream. */
function call(i: number, name: string, args: string, deltas: string[]): object[] {
  const id = `fc_${i}`
  const item = { id, call_id: `call_${i}`, type: "function_call", name }
  return [
    { type: "response.output_item.added", output_index: i, item: { ...item, arguments: "" } },
    ...deltas.map((delta) => ({
      type: "response.function_call_arguments.delta",
      output_index: i,
      item_id: id,
      delta,
    })),
    {
      type: "response.function_call_arguments.done",
      output_index: i,
      item_id: id,
      arguments: args,
    },
    { type: "response.output_item.done", output_index: i, item: { ...item, arguments: args } },
  ]
}

const CREATED = { type: "response.created", response: { id: "resp_x", model: "m" } }
const COMPLETED = { type: "response.completed", response: { id: "resp_x", status: "completed" } }

/** The concatenated input deltas per canonical block index. */
function deltasByIndex(events: CanonicalEvent[]): Map<number, string> {
  const m = new Map<number, string>()
  for (const e of events) {
    if (e.type === "tool_use_input_delta") m.set(e.index, (m.get(e.index) ?? "") + e.partialJson)
  }
  return m
}

describe("Responses function-call arguments", () => {
  it("sends the full arguments as one delta when no delta streamed (parallel calls)", async () => {
    const bash = '{"command":"git status","timeout":20000}'
    const glob = '{"pattern":"**/AGENTS.md"}'
    const events = await translate([
      CREATED,
      ...call(0, "Bash", bash, []),
      ...call(1, "Glob", glob, []),
      COMPLETED,
    ])
    const starts = events.filter((e) => e.type === "tool_use_start")
    expect(starts.map((e) => e.index)).toEqual([0, 1])
    expect([...deltasByIndex(events).entries()]).toEqual([
      [0, bash],
      [1, glob],
    ])
    const stops = events.filter((e) => e.type === "tool_use_stop")
    expect(stops.map((e) => e.input)).toEqual([JSON.parse(bash), JSON.parse(glob)])
  })

  it("does not repeat the arguments when deltas streamed", async () => {
    const args = '{"command":"ls"}'
    const events = await translate([
      CREATED,
      ...call(0, "Bash", args, ['{"command":', '"ls"}']),
      COMPLETED,
    ])
    expect(deltasByIndex(events).get(0)).toBe(args)
    expect(events.filter((e) => e.type === "tool_use_input_delta")).toHaveLength(2)
  })

  it("handles a mix: one call with deltas, one without", async () => {
    const a = '{"action":"list"}'
    const b = '{"peer":"Scott"}'
    const events = await translate([
      CREATED,
      ...call(0, "Task", a, [a]),
      ...call(1, "IntercomPeers", b, []),
      COMPLETED,
    ])
    expect([...deltasByIndex(events).entries()]).toEqual([
      [0, a],
      [1, b],
    ])
  })

  it("sends no delta for an empty arguments string", async () => {
    const events = await translate([CREATED, ...call(0, "SubAgentsListAgents", "", []), COMPLETED])
    expect(events.some((e) => e.type === "tool_use_input_delta")).toBe(false)
    expect(events.find((e) => e.type === "tool_use_stop")).toMatchObject({ input: {} })
  })
})
