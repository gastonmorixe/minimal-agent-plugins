/**
 * Tests of the `SessionTitle` tool with a fake host (no network, no real
 * home: `MINIMAL_AGENT_HOME` is a temp dir in each env).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { pluginSideband } from "../../tests/support/sideband.ts"
import { fakeDisplay, realDisplaySideband, writePaste } from "../__fixtures__/display-sideband.ts"
import type {
  EventHandlerContext,
  LlmSideRequest,
  LlmSideResult,
  ModelView,
  SessionMessageSlice,
  SessionTitleInput,
  SessionTitleState,
  TitleHost,
  TitleSideband,
  TitleToolContext,
} from "../lib/host-types.ts"
import { loadPromptBodies } from "../lib/prompt-library.ts"
import { createTitleShared } from "../lib/shared.ts"

import { createTitleHandler, SYSTEM_PROMPT, TITLE_SAVED_EVENT } from "./on_prompt_submitted.ts"
import {
  conversationText,
  createSessionTitleTool,
  messageText,
  REGENERATE_COOLDOWN_MS,
} from "./session_title_tool.ts"

const sb = await pluginSideband()

const SID = "ba0ad20f-0000-4000-8000-666ff6ccaa5b"
const CHEAP: ModelView = {
  id: "cheap-1",
  providerId: "prov",
  tags: ["utility"],
  capabilities: { structuredOutputs: true },
  pricing: { inputUSD: 0.1, outputUSD: 0.5 },
}

interface Fake {
  host: TitleHost
  requests: LlmSideRequest[]
  writes: SessionTitleInput[]
  state: SessionTitleState
  messages: SessionMessageSlice[]
  respond: () => Promise<LlmSideResult>
  /** The `ctx.sideband` of the tool. Default: the real codec with no display handler. */
  sideband?: TitleSideband
}

function okResult(title = "DEV-244 shared project view"): LlmSideResult {
  return {
    text: JSON.stringify({ title }),
    json: { title },
    stopReason: "end_turn",
    model: "cheap-1",
    provider: "prov",
    usage: { inputTokens: 500, outputTokens: 9 },
    costUsd: 0.0001,
    latencyMs: 300,
  }
}

/** A fake host. `setTitle` acts like core: an `ai` write is dropped when a user title exists. */
function makeFake(): Fake {
  const fake: Fake = {
    requests: [],
    writes: [],
    state: {},
    messages: [],
    respond: async () => okResult(),
    host: undefined as unknown as TitleHost,
  }
  fake.host = {
    llm: {
      request: (req) => {
        fake.requests.push(req)
        return fake.respond()
      },
    },
    sessionMeta: {
      getTitle: (sid) => (sid === SID ? fake.state : {}),
      setTitle: async (input) => {
        fake.writes.push(input)
        if (input.source === "ai" && fake.state.user) return
        const rec = {
          kind: "title" as const,
          v: 1 as const,
          sid: input.sid,
          title: input.title.slice(0, 80),
          source: input.source,
          at: "x",
        }
        fake.state = { ...fake.state, [input.source]: rec }
      },
    },
    models: {
      find: (id) => (id === CHEAP.id ? CHEAP : undefined),
      findForProvider: (id) => (id === CHEAP.id ? CHEAP : undefined),
      list: () => [CHEAP],
      findByTags: () => undefined,
      utilityFor: () => ({
        modelId: "cheap-1",
        providerId: "prov",
        structured: "json_schema",
        thinkingOff: true,
        effort: "low",
        stream: "off",
        pricing: CHEAP.pricing,
      }),
    },
    sessions: {
      title: () => null,
      meta: async () => ({ sid: SID, parentSid: null }),
      records: async (sid) => (sid === SID ? { sid, messages: fake.messages } : null),
    },
  }
  return fake
}

let home: string
let env: Record<string, string>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ma-title-tool-"))
  env = { MINIMAL_AGENT_HOME: join(home, ".minimal-agent"), MINIMAL_AGENT_TITLE: "1" }
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function toolCtx(fake: Fake, input: Record<string, unknown>): TitleToolContext {
  return {
    trigger: { type: "tool", name: "SessionTitle", input, tool_use_id: "tu_1" },
    env,
    abort: new AbortController().signal,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agent: { sessionId: SID, model: "cheap-1" },
    run: { mode: "repl", interactive: true, providerId: "prov" },
    sideband: fake.sideband ?? sb,
    host: fake.host,
  }
}

/** A shared state with a bus emit that records the events. */
function sharedWithBus(): { shared: ReturnType<typeof createTitleShared>; events: unknown[] } {
  const shared = createTitleShared()
  const events: unknown[] = []
  shared.emit = (ev, p) => {
    if (ev === TITLE_SAVED_EVENT) events.push(p)
  }
  return { shared, events }
}

describe("SessionTitle tool: a given title", () => {
  test("writes an ai title, sends title.saved and gives the saved title", async () => {
    const fake = makeFake()
    const { shared, events } = sharedWithBus()
    const res = await createSessionTitleTool(shared)(toolCtx(fake, { title: "Paste ref titles" }))
    expect(res.is_error).toBeUndefined()
    expect(res.content).toBe("Title: Paste ref titles (source: ai)")
    expect(fake.writes).toEqual([{ sid: SID, source: "ai", title: "Paste ref titles" }])
    expect(fake.requests).toHaveLength(0)
    expect(events).toEqual([{ sid: SID, title: "Paste ref titles", source: "ai" }])
    expect(shared.states.get(SID)).toMatchObject({ done: true, inFlight: false })
  })

  test("the result has the title that the host saved (core cap)", async () => {
    const fake = makeFake()
    const long = "x".repeat(100)
    const res = await createSessionTitleTool(createTitleShared())(toolCtx(fake, { title: long }))
    expect(res.content).toBe(`Title: ${long.slice(0, 80)} (source: ai)`)
  })

  test("lock: true writes a user title", async () => {
    const fake = makeFake()
    const { shared, events } = sharedWithBus()
    const res = await createSessionTitleTool(shared)(
      toolCtx(fake, { title: "My own title", lock: true }),
    )
    expect(res.content).toBe("Title: My own title (source: user)")
    expect(fake.writes).toEqual([{ sid: SID, source: "user", title: "My own title" }])
    expect(events).toEqual([{ sid: SID, title: "My own title", source: "user" }])
  })

  test("lock: false with a user title writes nothing and says why", async () => {
    const fake = makeFake()
    fake.state = { user: { kind: "title", v: 1, sid: SID, title: "Kept", source: "user", at: "x" } }
    const { shared, events } = sharedWithBus()
    const res = await createSessionTitleTool(shared)(toolCtx(fake, { title: "New one" }))
    expect(res.is_error).toBe(true)
    expect(res.content).toContain("A user title exists")
    expect(res.content).toContain("lock: true")
    expect(fake.writes).toHaveLength(0)
    expect(fake.requests).toHaveLength(0)
    expect(events).toHaveLength(0)
  })

  test("lock: true replaces a user title", async () => {
    const fake = makeFake()
    fake.state = { user: { kind: "title", v: 1, sid: SID, title: "Old", source: "user", at: "x" } }
    const res = await createSessionTitleTool(createTitleShared())(
      toolCtx(fake, { title: "New", lock: true }),
    )
    expect(res.content).toBe("Title: New (source: user)")
  })

  test("bad input, no sid or no sessionMeta gives an error", async () => {
    const fake = makeFake()
    const tool = createSessionTitleTool(createTitleShared())
    expect((await tool(toolCtx(fake, { title: 5 }))).is_error).toBe(true)
    expect((await tool(toolCtx(fake, { title: "  " }))).is_error).toBe(true)
    expect((await tool(toolCtx(fake, { lock: "yes" }))).is_error).toBe(true)
    const noSid = { ...toolCtx(fake, { title: "X y" }), agent: undefined }
    expect((await tool(noSid)).content).toContain("no session id")
    const noMeta = {
      ...toolCtx(fake, { title: "X y" }),
      host: { ...fake.host, sessionMeta: undefined },
    }
    expect((await tool(noMeta)).content).toContain("sessions:meta")
    expect(fake.writes).toHaveLength(0)
  })
})

describe("SessionTitle tool: no title (the model makes one)", () => {
  test("calls llm.request with text from the records, then writes the result", async () => {
    const dir = join(home, "sessions")
    writePaste(
      dir,
      SID,
      "m23a7",
      "https://linear.app/arcanums/issue/DEV-244/user-can-make-a-shared-project-view-only-for-a-team",
    )
    const fake = makeFake()
    fake.sideband = await realDisplaySideband(dir)
    const ref = sb.render("paste", { attrs: { id: "m23a7", bytes: 93, lines: 1 } })
    fake.state = {
      ai: { kind: "title", v: 1, sid: SID, title: "Status of arcana", source: "ai", at: "x" },
    }
    fake.messages = [
      { role: "user", content: `&arcana-access-prod\n---\nwhat's the status of ${ref} ?` },
      { role: "assistant", content: "assistant text must not go" },
      { role: "user", content: [{ type: "text", text: "second message" }] },
      { role: "user", content: [{ type: "tool_result" }] },
      { role: "user", content: "third message" },
      { role: "user", content: "fourth message" },
      { role: "user", content: "fifth message" },
    ]
    const { shared, events } = sharedWithBus()
    const res = await createSessionTitleTool(shared)(toolCtx(fake, {}))

    expect(fake.requests).toHaveLength(1)
    const req = fake.requests[0]
    expect(req).toMatchObject({
      purpose: "title",
      model: "cheap-1",
      system: SYSTEM_PROMPT,
      maxTokens: 256,
      thinking: "off",
    })
    const text = req?.userText ?? ""
    expect(text).toContain("DEV-244")
    expect(text).toContain("user-can-make-a-shared-project-view-only-for-a-team")
    expect(text).not.toContain("&arcana-access-prod")
    expect(text).not.toContain("assistant text")
    // The first message and the last 3: "second message" is not one of them.
    expect(text).not.toContain("second message")
    for (const m of ["third message", "fourth message", "fifth message"]) {
      expect(text).toContain(m)
    }
    expect(fake.writes).toHaveLength(1)
    expect(fake.writes[0]).toMatchObject({
      sid: SID,
      source: "ai",
      title: "DEV-244 shared project view",
      model: "cheap-1",
      provider: "prov",
    })
    expect(res.content).toBe("Title: DEV-244 shared project view (source: ai)")
    expect(events).toHaveLength(1)
  })

  test("a bad model result gives an error with the stop reason and writes nothing", async () => {
    const fake = makeFake()
    fake.messages = [{ role: "user", content: "fix the footer title refresh" }]
    fake.respond = async () => ({ ...okResult(), stopReason: "max_tokens" })
    const res = await createSessionTitleTool(createTitleShared())(toolCtx(fake, {}))
    expect(res.is_error).toBe(true)
    expect(res.content).toContain("max_tokens")
    expect(fake.writes).toHaveLength(0)
  })

  test("a session with no user text gives an error and no call", async () => {
    const fake = makeFake()
    const res = await createSessionTitleTool(createTitleShared())(toolCtx(fake, {}))
    expect(res.is_error).toBe(true)
    expect(fake.requests).toHaveLength(0)
  })
})

describe("SessionTitle tool and the automatic handler", () => {
  test("the automatic handler skips a sid after the tool wrote", async () => {
    const fake = makeFake()
    const shared = createTitleShared()
    const auto = createTitleHandler({ shared })
    await createSessionTitleTool(shared)(toolCtx(fake, { title: "Tool title" }))
    // The fake keeps no ai state for the auto check: only the shared state stops it.
    fake.state = {}
    const logs: string[] = []
    const ctx: EventHandlerContext = {
      event: "prompt.submitted",
      payload: {
        text: "write the design spec for a title plugin",
        cwd: "/",
        sid: SID,
        exit: "submitted",
        queuePos: 0,
        source: "user",
      },
      env,
      emit: () => {},
      abort: new AbortController().signal,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: (_s, m) => logs.push(m) },
      agent: { sessionId: SID, model: "cheap-1" },
      run: { mode: "repl", interactive: true, providerId: "prov" },
      sideband: sb,
      host: fake.host,
    }
    await auto.handler(ctx)
    await auto.idle()
    expect(fake.requests).toHaveLength(0)
    expect(fake.writes).toHaveLength(1)
    expect(logs.some((l) => l.includes("rule=3 done"))).toBe(true)
  })

  test("the tool sends title.saved with the bus emit of the event handler", async () => {
    const fake = makeFake()
    const shared = createTitleShared()
    const auto = createTitleHandler({ shared })
    const seen: Array<[string, unknown]> = []
    await auto.handler({
      event: "prompt.submitted",
      payload: { text: "/x", cwd: "/", sid: SID, exit: "submitted", queuePos: 0, source: "user" },
      env,
      emit: (ev, p) => seen.push([ev, p]),
      abort: new AbortController().signal,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      agent: { sessionId: SID, model: "cheap-1" },
      run: { mode: "repl", interactive: true, providerId: "prov" },
      sideband: sb,
      host: fake.host,
    })
    await createSessionTitleTool(shared)(toolCtx(fake, { title: "Bus title" }))
    expect(seen).toEqual([[TITLE_SAVED_EVENT, { sid: SID, title: "Bus title", source: "ai" }]])
  })
})

describe("conversationText / messageText", () => {
  test("text blocks only, internal blocks are not user text", () => {
    expect(
      messageText({
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "policy", sideband: { kind: "policy" } },
          { type: "image" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb")
  })

  test("first and last 3 user messages, no copy when there are few", () => {
    const msgs: SessionMessageSlice[] = [
      { role: "user", content: "one" },
      { role: "user", content: "two" },
    ]
    expect(conversationText(msgs, sb)).toBe("one\n\ntwo")
    expect(conversationText([{ role: "user", content: "only" }], sb)).toBe("only")
    expect(conversationText([], sb)).toBe("")
  })
})

describe("SessionTitle tool: round 2 fixes", () => {
  test("M1: the generate path gives an error and no call when MINIMAL_AGENT_TITLE=0", async () => {
    const fake = makeFake()
    fake.messages = [{ role: "user", content: "fix the footer title refresh" }]
    env.MINIMAL_AGENT_TITLE = "0"
    const tool = createSessionTitleTool(createTitleShared())
    const res = await tool(toolCtx(fake, {}))
    expect(res.is_error).toBe(true)
    expect(res.content).toContain("off")
    expect(fake.requests).toHaveLength(0)
    expect(fake.writes).toHaveLength(0)
    // A given title still works, with no model call.
    const given = await tool(toolCtx(fake, { title: "Footer refresh" }))
    expect(given.content).toBe("Title: Footer refresh (source: ai)")
    expect(fake.requests).toHaveLength(0)
  })

  test("M1: the generate path gives an error and no call when the config turns the plugin off", async () => {
    const fake = makeFake()
    fake.messages = [{ role: "user", content: "fix the footer title refresh" }]
    const agentHome = env.MINIMAL_AGENT_HOME ?? ""
    mkdirSync(agentHome, { recursive: true })
    writeFileSync(
      join(agentHome, "config.jsonc"),
      JSON.stringify({ plugins: { title: { enabled: false } } }),
    )
    delete env.MINIMAL_AGENT_TITLE
    const res = await createSessionTitleTool(createTitleShared())(toolCtx(fake, {}))
    expect(res.is_error).toBe(true)
    expect(fake.requests).toHaveLength(0)
  })

  test("m5: lock true with no title gives an error and no call", async () => {
    const fake = makeFake()
    fake.messages = [{ role: "user", content: "fix the footer title refresh" }]
    const res = await createSessionTitleTool(createTitleShared())(toolCtx(fake, { lock: true }))
    expect(res.is_error).toBe(true)
    expect(res.content).toContain("lock")
    expect(fake.requests).toHaveLength(0)
    expect(fake.writes).toHaveLength(0)
  })

  const ACCESS_BODY =
    "<arcana-access>\nUse read-only access to the arcana-access prod server.\nDo not change data.\n</arcana-access>"
  const WORK_BODY =
    "Tracked work package: write the ticket id first, then make a work folder with PROGRESS.md."

  test("M3: the saved prompt bodies in the records do not go to the model", async () => {
    const dir = join(home, "sessions")
    writePaste(
      dir,
      SID,
      "m23a7",
      "https://linear.app/arcanums/issue/DEV-244/user-can-make-a-shared-project-view-only-for-a-team",
    )
    const fake = makeFake()
    fake.sideband = await realDisplaySideband(dir)
    const ref = sb.render("paste", { attrs: { id: "m23a7", bytes: 93, lines: 1 } })
    const expanded = `${ACCESS_BODY}\r\n---\r\n${WORK_BODY}\n\nTask:\n---\n\nwhat's the status of ${ref}`
    fake.messages = [{ role: "user", content: expanded }]
    const tool = createSessionTitleTool(createTitleShared(), {
      promptBodies: () => [`${ACCESS_BODY}\n`, WORK_BODY, "  "],
    })
    await tool(toolCtx(fake, {}))
    const text = fake.requests[0]?.userText ?? ""
    expect(text).toContain("DEV-244")
    expect(text).toContain("user-can-make-a-shared-project-view-only-for-a-team")
    expect(text).not.toContain("arcana-access")
    expect(text).not.toContain("Tracked work package")
  })

  test("M3: the default loader reads the user and the project prompt files", async () => {
    const userDir = join(env.MINIMAL_AGENT_HOME ?? "", "prompts")
    const cwd = join(home, "project")
    const projectDir = join(cwd, ".agents", "prompts")
    mkdirSync(userDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(userDir, "arcana-access-prod.md"),
      `---\nname: arcana-access-prod\ndescription: access\n---\n${ACCESS_BODY}\n`,
    )
    writeFileSync(
      join(projectDir, "arcana-work.md"),
      `---\r\nname: arcana-work\r\ndescription: work\r\n---\r\n${WORK_BODY}\r\n`,
    )
    writeFileSync(join(userDir, "notes.txt"), "not a prompt")
    const bodies = loadPromptBodies(env, cwd)
    expect(bodies).toContain(ACCESS_BODY)
    expect(bodies).toContain(WORK_BODY)
    expect(bodies).toHaveLength(2)
  })

  test("M3: the first text of the shared state is the first part", async () => {
    const fake = makeFake()
    fake.messages = [
      { role: "user", content: `${ACCESS_BODY}\n\nwhat is the state of DEV-244` },
      { role: "user", content: "and the next step" },
    ]
    const shared = createTitleShared()
    shared.states.set(SID, {
      attempts: 0,
      inFlight: false,
      done: false,
      firstText: "DEV-244 state",
    })
    await createSessionTitleTool(shared, { promptBodies: () => [] })(toolCtx(fake, {}))
    const text = fake.requests[0]?.userText ?? ""
    expect(text).toContain("<session>\nDEV-244 state\n\nand the next step\n</session>")
    expect(text).not.toContain("arcana-access")
  })

  test("m8: conversationText reads the paste files of the first and the last 3 only", () => {
    const shown = fakeDisplay(sb, () => ({ label: "paste", text: "pasted" }))
    const ref = sb.render("paste", { attrs: { id: "m23a7", bytes: 6, lines: 1 } })
    const msgs: SessionMessageSlice[] = []
    for (let i = 1; i <= 7; i++) msgs.push({ role: "user", content: `message ${i} ${ref}` })
    msgs.push({ role: "user", content: [{ type: "tool_result" }] })
    const out = conversationText(msgs, shown, { sid: SID })
    expect(out).toBe(
      ["message 1 pasted", "message 5 pasted", "message 6 pasted", "message 7 pasted"].join("\n\n"),
    )
    expect(shown.calls).toHaveLength(4)
    expect(shown.calls.every((c) => c.opts.sid === SID)).toBe(true)
  })

  test("m4: an auto result that comes during the tool write is dropped", async () => {
    const fake = makeFake()
    const shared = createTitleShared()
    const auto = createTitleHandler({ shared })
    let releaseLlm: (r: LlmSideResult) => void = () => {}
    fake.respond = () =>
      new Promise<LlmSideResult>((r) => {
        releaseLlm = r
      })
    const meta = fake.host.sessionMeta
    if (!meta) throw new Error("fake has no sessionMeta")
    const realSet = meta.setTitle.bind(meta)
    let releaseWrite: () => void = () => {}
    const toolWrite = new Promise<void>((r) => {
      releaseWrite = r
    })
    fake.host = {
      ...fake.host,
      sessionMeta: {
        getTitle: meta.getTitle,
        setTitle: async (input) => {
          if (input.title === "Tool title") await toolWrite
          await realSet(input)
        },
      },
    }
    await auto.handler({
      event: "prompt.submitted",
      payload: {
        text: "write the design spec for a title plugin",
        cwd: "/",
        sid: SID,
        exit: "submitted",
        queuePos: 0,
        source: "user",
      },
      env,
      emit: () => {},
      abort: new AbortController().signal,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      agent: { sessionId: SID, model: "cheap-1" },
      run: { mode: "repl", interactive: true, providerId: "prov" },
      sideband: sb,
      host: fake.host,
    })
    // Wait until the auto call waits for the model.
    for (let i = 0; i < 50 && fake.requests.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(fake.requests).toHaveLength(1)
    const toolRun = createSessionTitleTool(shared)(toolCtx(fake, { title: "Tool title" }))
    releaseLlm(okResult("Auto title"))
    await auto.idle()
    releaseWrite()
    const res = await toolRun
    expect(fake.writes.map((w) => w.title)).toEqual(["Tool title"])
    expect(res.content).toBe("Title: Tool title (source: ai)")
  })
})

describe("SessionTitle tool: manifest and system prompt text (m5, m6, m10)", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "manifest.json"), "utf8"),
  ) as { headless: { tools: Array<{ trigger: { tool: Record<string, unknown> } }> } }
  const tool = manifest.headless.tools[0]?.trigger.tool ?? {}

  test("the description tells when to call the tool and when not to", () => {
    const d = String(tool.description)
    expect(d).toContain("Use it only when the user tells you to set or change the title.")
    expect(d).toContain("Do not use it to read the title.")
    expect(d).toContain("Do not use it on each turn.")
  })

  test("the explicitName reason names the stutter", () => {
    expect(tool.reason).toBe("TitleSessionTitle is a stutter")
  })

  test("rule 10 keeps the id as it is and has priority over rules 2 and 3", () => {
    expect(SYSTEM_PROMPT).toContain("Keep the id as it is in the text, for example `DEV-244`.")
    expect(SYSTEM_PROMPT).toContain(
      "If this rule and rule 2 or rule 3 do not agree, obey this rule.",
    )
    expect(SYSTEM_PROMPT).toContain(
      "If the text starts with general instructions and then a request, write the name of the item of the request.",
    )
  })
})

describe("SessionTitle tool: regenerate cooldown", () => {
  const MIN = 60 * 1000

  /** A tool with a fake clock. */
  function clockTool(shared = createTitleShared()): {
    tool: ReturnType<typeof createSessionTitleTool>
    clock: { t: number }
  } {
    const clock = { t: 1_000_000 }
    const tool = createSessionTitleTool(shared, { promptBodies: () => [], now: () => clock.t })
    return { tool, clock }
  }

  test("the cooldown is 10 minutes", () => {
    expect(REGENERATE_COOLDOWN_MS).toBe(10 * MIN)
  })

  test("a second generate call inside 10 minutes gives an error and no model call", async () => {
    const fake = makeFake()
    fake.messages = [{ role: "user", content: "fix the footer title refresh" }]
    const { tool, clock } = clockTool()
    const first = await tool(toolCtx(fake, {}))
    expect(first.is_error).toBeUndefined()
    expect(fake.requests).toHaveLength(1)
    clock.t += 3 * MIN
    const second = await tool(toolCtx(fake, {}))
    expect(second.is_error).toBe(true)
    expect(second.content).toContain("3 minutes ago")
    expect(second.content).toContain('"DEV-244 shared project view"')
    expect(second.content).toContain("title field")
    expect(fake.requests).toHaveLength(1)
    expect(fake.writes).toHaveLength(1)
  })

  test("the error shows the user title first, then the ai title, then the derived title", async () => {
    const fake = makeFake()
    fake.messages = [{ role: "user", content: "fix the footer title refresh" }]
    const { tool, clock } = clockTool()
    await tool(toolCtx(fake, {}))
    clock.t += MIN
    const rec = (title: string, source: "ai" | "user" | "derived") => ({
      kind: "title" as const,
      v: 1 as const,
      sid: SID,
      title,
      source,
      at: "x",
    })
    fake.state = { derived: rec("Derived one", "derived") }
    expect((await tool(toolCtx(fake, {}))).content).toContain('"Derived one"')
    fake.state = { ai: rec("Ai one", "ai"), derived: rec("Derived one", "derived") }
    expect((await tool(toolCtx(fake, {}))).content).toContain('"Ai one"')
    expect(fake.requests).toHaveLength(1)
  })

  test("after 10 minutes a generate call makes a model call", async () => {
    const fake = makeFake()
    fake.messages = [{ role: "user", content: "fix the footer title refresh" }]
    const { tool, clock } = clockTool()
    await tool(toolCtx(fake, {}))
    clock.t += 10 * MIN
    const res = await tool(toolCtx(fake, {}))
    expect(res.is_error).toBeUndefined()
    expect(fake.requests).toHaveLength(2)
  })

  test("a given title inside the window writes, with no model call", async () => {
    const fake = makeFake()
    fake.messages = [{ role: "user", content: "fix the footer title refresh" }]
    const { tool, clock } = clockTool()
    await tool(toolCtx(fake, {}))
    clock.t += MIN
    const res = await tool(toolCtx(fake, { title: "Footer refresh" }))
    expect(res.content).toBe("Title: Footer refresh (source: ai)")
    expect(fake.requests).toHaveLength(1)
    expect(fake.writes.map((w) => w.title)).toEqual([
      "DEV-244 shared project view",
      "Footer refresh",
    ])
  })

  test("a failed generate call also starts the window", async () => {
    const fake = makeFake()
    fake.messages = [{ role: "user", content: "fix the footer title refresh" }]
    fake.respond = async () => {
      throw new Error("provider down")
    }
    const { tool, clock } = clockTool()
    const first = await tool(toolCtx(fake, {}))
    expect(first.is_error).toBe(true)
    expect(first.content).toContain("provider down")
    clock.t += 2 * MIN
    fake.respond = async () => okResult()
    const second = await tool(toolCtx(fake, {}))
    expect(second.is_error).toBe(true)
    expect(second.content).toContain("2 minutes ago")
    expect(fake.requests).toHaveLength(1)
  })

  test("a generate call that stops before the model call does not start the window", async () => {
    const fake = makeFake()
    const { tool } = clockTool()
    // No user text: no model call.
    expect((await tool(toolCtx(fake, {}))).is_error).toBe(true)
    fake.messages = [{ role: "user", content: "fix the footer title refresh" }]
    const res = await tool(toolCtx(fake, {}))
    expect(res.is_error).toBeUndefined()
    expect(fake.requests).toHaveLength(1)
  })

  test("two sids are independent", async () => {
    const OTHER = "ba0ad20f-0000-4000-8000-777ff6ccaa5c"
    const fake = makeFake()
    fake.messages = [{ role: "user", content: "fix the footer title refresh" }]
    const baseRecords = fake.host.sessions?.records
    const meta = fake.host.sessionMeta
    if (!meta) throw new Error("fake has no sessionMeta")
    fake.host = {
      ...fake.host,
      sessionMeta: { getTitle: () => fake.state, setTitle: meta.setTitle },
      sessions: {
        title: () => null,
        meta: async (sid) => ({ sid, parentSid: null }),
        records: async (sid) =>
          sid === OTHER ? { sid, messages: fake.messages } : (baseRecords?.(sid) ?? null),
      },
    }
    const shared = createTitleShared()
    const { tool, clock } = clockTool(shared)
    await tool(toolCtx(fake, {}))
    clock.t += MIN
    const other = { ...toolCtx(fake, {}), agent: { sessionId: OTHER, model: "cheap-1" } }
    const res = await tool(other)
    expect(res.is_error).toBeUndefined()
    expect(fake.requests).toHaveLength(2)
    // The first sid is still in its window.
    expect((await tool(toolCtx(fake, {}))).is_error).toBe(true)
    expect(fake.requests).toHaveLength(2)
  })
})
