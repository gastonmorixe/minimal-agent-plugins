/**
 * In-process tests for `permission.ts`: the ACP approval gate. Every
 * failure of the `session/request_permission` round trip denies that one
 * tool call (a hook halt with a reason). It never throws.
 *
 * @module permission.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import {
  activeGate,
  createPermissionGate,
  type PermissionRequest,
  parseHostModeArgs,
  setActiveGate,
} from "./permission.ts"
import toolWillInvoke from "./permission-hook.ts"

const bash = { tool: "Bash", toolUseId: "tu_1", input: { command: "ls" }, cwd: "/w" }
const read = { tool: "Read", toolUseId: "tu_2", input: { file_path: "/w/a" }, cwd: "/w" }

interface Sent {
  readonly method: string
  readonly params: Record<string, unknown>
}

/** A fake `channel.request` that answers each call with the next item of `answers`. */
function fakeRequest(answers: ReadonlyArray<(signal: AbortSignal) => Promise<unknown>>) {
  const sent: Sent[] = []
  let i = 0
  const request: PermissionRequest = (method, params, signal) => {
    sent.push({ method, params: params as Record<string, unknown> })
    const next = answers[i++]
    if (!next) return Promise.reject(new Error("no scripted answer"))
    return next(signal)
  }
  return { request, sent }
}

const selected = (optionId: unknown) => () =>
  Promise.resolve({ outcome: { outcome: "selected", optionId } })

function gateWith(
  answers: ReadonlyArray<(signal: AbortSignal) => Promise<unknown>>,
  deadlineMs?: number,
) {
  const fake = fakeRequest(answers)
  const gate = createPermissionGate({
    request: fake.request,
    sessionId: () => "s1",
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  })
  return { gate, sent: fake.sent }
}

function expectDeny(result: unknown, text: RegExp): void {
  expect(result).toMatchObject({ halt: true })
  expect((result as { reason: string }).reason).toMatch(text)
}

afterEach(() => setActiveGate(undefined))

describe("parseHostModeArgs", () => {
  it("is off by default", () => {
    expect(parseHostModeArgs([]).approval).toBe(false)
  })
  it("turns approval on with --approval", () => {
    expect(parseHostModeArgs(["--approval"]).approval).toBe(true)
  })
  it("reports unknown args and ignores them", () => {
    const r = parseHostModeArgs(["--nope", "--approval"])
    expect(r.approval).toBe(true)
    expect(r.unknown).toEqual(["--nope"])
  })
})

describe("permission gate request", () => {
  it("sends session/request_permission with the tool call and four options", async () => {
    const { gate, sent } = gateWith([selected("allow_once")])
    expect(await gate.check(bash)).toBeUndefined()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.method).toBe("session/request_permission")
    const params = sent[0]?.params as {
      sessionId: string
      toolCall: Record<string, unknown>
      options: { optionId: string; kind: string; name: string }[]
    }
    expect(params.sessionId).toBe("s1")
    expect(params.toolCall).toMatchObject({
      toolCallId: "tu_1",
      kind: "execute",
      status: "pending",
      rawInput: { command: "ls" },
    })
    expect(params.options.map((o) => [o.optionId, o.kind])).toEqual([
      ["allow_once", "allow_once"],
      ["allow_always", "allow_always"],
      ["reject_once", "reject_once"],
      ["reject_always", "reject_always"],
    ])
    for (const o of params.options) expect(o.name.length).toBeGreaterThan(0)
  })
})

describe("permission gate answers", () => {
  it("allow_once allows this call only", async () => {
    const { gate, sent } = gateWith([selected("allow_once"), selected("reject_once")])
    expect(await gate.check(bash)).toBeUndefined()
    expectDeny(await gate.check(bash), /rejected/)
    expect(sent).toHaveLength(2)
  })

  it("allow_always remembers the tool kind for this gate only", async () => {
    const { gate, sent } = gateWith([selected("allow_always"), selected("reject_once")])
    expect(await gate.check(bash)).toBeUndefined()
    expect(await gate.check({ ...bash, toolUseId: "tu_3" })).toBeUndefined()
    expect(sent).toHaveLength(1)
    // Another kind (read) still asks.
    expectDeny(await gate.check(read), /rejected/)
    expect(sent).toHaveLength(2)
    // A new gate (a new session) remembers nothing.
    const fresh = gateWith([selected("reject_once")])
    expectDeny(await fresh.gate.check(bash), /rejected/)
  })

  it("reject_once denies with a clear reason", async () => {
    const { gate } = gateWith([selected("reject_once")])
    expectDeny(await gate.check(bash), /rejected Bash/)
  })

  it("reject_always denies this kind from then on, without asking", async () => {
    const { gate, sent } = gateWith([selected("reject_always")])
    expectDeny(await gate.check(bash), /rejected/)
    expectDeny(await gate.check(bash), /rejected/)
    expect(sent).toHaveLength(1)
  })

  it("outcome cancelled denies", async () => {
    const { gate } = gateWith([() => Promise.resolve({ outcome: { outcome: "cancelled" } })])
    expectDeny(await gate.check(bash), /cancelled/)
  })

  it("an unknown option id denies", async () => {
    const { gate } = gateWith([selected("allow_everything")])
    expectDeny(await gate.check(bash), /unknown option/)
  })

  it("a malformed answer denies", async () => {
    for (const raw of [
      null,
      7,
      {},
      { outcome: "selected" },
      { outcome: { outcome: "selected" } },
    ]) {
      const { gate } = gateWith([() => Promise.resolve(raw)])
      expectDeny(await gate.check(bash), /malformed|unknown option/)
    }
  })
})

describe("permission gate failures", () => {
  it("a rejected request (JSON-RPC error, closed stdin) denies", async () => {
    const { gate } = gateWith([() => Promise.reject(new Error("channel closed"))])
    expectDeny(await gate.check(bash), /channel closed/)
  })

  it("a throwing request function denies", async () => {
    const gate = createPermissionGate({
      request: () => {
        throw new Error("sync boom")
      },
      sessionId: () => "s1",
    })
    expectDeny(await gate.check(bash), /sync boom/)
  })

  it("no session id denies", async () => {
    const gate = createPermissionGate({
      request: selected("allow_once"),
      sessionId: () => undefined,
    })
    expectDeny(await gate.check(bash), /no ACP session/)
  })

  it("the own deadline denies and aborts the request", async () => {
    let aborted = false
    const { gate } = gateWith(
      [
        (signal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true
              reject(signal.reason)
            })
          }),
      ],
      20,
    )
    expectDeny(await gate.check(bash), /no answer within 20 ms/)
    expect(aborted).toBe(true)
  })

  it("cancelPending denies a waiting request (session/cancel)", async () => {
    const { gate } = gateWith([
      (signal) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    ])
    const pending = gate.check(bash)
    gate.cancelPending()
    expectDeny(await pending, /session cancelled/)
  })
})

describe("permission hook module", () => {
  it("passes through when no gate is active (approval off)", async () => {
    expect(activeGate()).toBeUndefined()
    expect(await toolWillInvoke(bash)).toBeUndefined()
  })

  it("asks the active gate", async () => {
    const { gate } = gateWith([selected("reject_once")])
    setActiveGate(gate)
    expectDeny(await toolWillInvoke(bash), /rejected/)
  })

  it("a malformed payload denies", async () => {
    const { gate } = gateWith([selected("allow_once")])
    setActiveGate(gate)
    expectDeny(await toolWillInvoke(null), /malformed/)
  })
})
