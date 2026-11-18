import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { STE_REWRITES, toSte } from "./__fixtures__/ste-p4.ts"
import createProvider, { createBaseProvider, fill } from "./provider.ts"

const FIX = join(import.meta.dir, "__fixtures__")
const SYSTEM_FIXTURE = join(
  import.meta.dir,
  "..",
  "tests",
  "text-parity",
  "fixtures",
  "system.json",
)
const TMP = join(import.meta.dir, "tmp-provider-test")
const ctx = { authKind: "k", modelId: "m" }
const bytes = (s: string) => Buffer.from(s, "utf-8")
/** An old core fixture, mapped to the P4 STE text (see `__fixtures__/ste-p4.ts`). */
const fixture = (name: string) => bytes(toSte(readFileSync(join(FIX, name), "utf-8")).text)

function stage(name: string): string {
  const dir = join(TMP, name)
  mkdirSync(join(dir, "prompts"), { recursive: true })
  cpSync(join(import.meta.dir, "prompts"), join(dir, "prompts"), { recursive: true })
  return dir
}

/** Reader of a staged `<dir>/prompts` copy, read at each call. */
const diskReader = (dir: string) => (name: string) =>
  readFileSync(join(dir, "prompts", name), "utf-8")

describe("base prompt provider", () => {
  beforeAll(() => rmSync(TMP, { recursive: true, force: true }))
  afterAll(() => rmSync(TMP, { recursive: true, force: true }))

  test("identity equals the STE text of the old core identity", () => {
    const id = createProvider().identity?.(ctx) ?? ""
    expect(bytes(id).equals(fixture("old-identity.txt"))).toBe(true)
  })

  test("instruction parts hold one instructions part equal to the STE text of the old core bytes", () => {
    const parts = createProvider().instructionParts?.() ?? []
    expect(parts).toHaveLength(1)
    expect(parts[0]?.slot).toBe("instructions")
    expect(bytes(parts[0]?.text ?? "").equals(fixture("old-instructions.txt"))).toBe(true)
  })

  test("trailing newlines and blank lines in the data files are trimmed", () => {
    const dir = stage("trim")
    appendFileSync(join(dir, "prompts", "identity.neutral.md"), "\n")
    appendFileSync(join(dir, "prompts", "identity.neutral.md"), "\n \n")
    appendFileSync(join(dir, "prompts", "instructions.md"), "\n")
    appendFileSync(join(dir, "prompts", "instructions.md"), "\n \n")
    const p = createBaseProvider(diskReader(dir))
    expect(bytes(p.identity?.(ctx) ?? "").equals(fixture("old-identity.txt"))).toBe(true)
    const text = p.instructionParts?.()[0]?.text ?? ""
    expect(bytes(text).equals(fixture("old-instructions.txt"))).toBe(true)
  })

  test("an empty data file gives an empty part, with no fallback to the default", () => {
    const dir = stage("empty")
    writeFileSync(join(dir, "prompts", "identity.neutral.md"), "")
    writeFileSync(join(dir, "prompts", "instructions.md"), "")
    const p = createBaseProvider(diskReader(dir))
    expect(p.identity?.(ctx)).toBe("")
    expect(p.instructionParts?.()).toEqual([{ slot: "instructions", text: "" }])
  })

  test("the provider reads the files at first call, not at creation", () => {
    const dir = stage("lazy")
    const p = createBaseProvider(diskReader(dir))
    writeFileSync(join(dir, "prompts", "identity.neutral.md"), "late\n")
    expect(p.identity?.(ctx)).toBe("late")
  })

  test("the instructions file is read at the first call of instructionParts, not at creation", () => {
    const dir = stage("lazy-instructions")
    const p = createBaseProvider(diskReader(dir))
    writeFileSync(join(dir, "prompts", "instructions.md"), "late instructions\n")
    expect(p.instructionParts?.()).toEqual([{ slot: "instructions", text: "late instructions" }])
  })

  test("the instructions text is read once and kept after the first call", () => {
    const dir = stage("memo-instructions")
    const p = createBaseProvider(diskReader(dir))
    const first = p.instructionParts?.()[0]?.text
    writeFileSync(join(dir, "prompts", "instructions.md"), "changed after the first call\n")
    expect(p.instructionParts?.()[0]?.text).toBe(first ?? "")
  })

  // The provider fills each template with a fixed set of names, so an unknown
  // name cannot reach the model.
  test("each data file uses only the placeholders the provider fills", () => {
    const read = (name: string) => readFileSync(join(import.meta.dir, "prompts", name), "utf-8")
    const names = (name: string) =>
      new Set([...read(name).matchAll(/%%([A-Za-z0-9_.-]+\??)%%/g)].map((m) => m[1]))
    expect(names("identity.neutral.md")).toEqual(new Set())
    expect(names("instructions.md")).toEqual(new Set(["agentHome"]))
    expect(names("loop-safety/checkpoint-cooldown.tmpl.md")).toEqual(
      new Set(["interval", "cooldownSec"]),
    )
    expect(names("loop-safety/checkpoint-plain.tmpl.md")).toEqual(new Set(["interval"]))
    for (const f of ["heading.md", "intro.md", "ack.md"]) {
      expect(names(`loop-safety/${f}`)).toEqual(new Set())
    }
    expect(names("tool-output-conventions.md")).toEqual(new Set(["agentHome"]))
  })

  test("the provider declares the 3 system slots as data", () => {
    expect(createProvider().slots).toEqual(["instructions", "loopSafety", "toolOutputConventions"])
  })

  test("fill replaces each name and throws on a name with no value", () => {
    expect(fill("a %%x%% b %%x%%", { x: 1 })).toBe("a 1 b 1")
    expect(() => fill("%%y%%", {})).toThrow()
  })
})

interface GridEntry {
  ctx: {
    reflectionInterval: number
    reflectionCooldownMs: number
    blobStoreEnabled: boolean
    agentHome: string
  }
  instructions: string | null
  loopSafety: string | null
  toolOutputConventions: string | null
}
interface SystemFixture {
  identity: string
  instructionsTemplate: string
  grid: GridEntry[]
}
const oldSystem = JSON.parse(readFileSync(SYSTEM_FIXTURE, "utf-8")) as SystemFixture
const ste = (t: string): string => toSte(t).text
const steOrNull = (t: string | null): string | null => (t === null ? null : ste(t))
/** The core fixture with each old text mapped to its P4 STE text. */
const system: SystemFixture = {
  identity: ste(oldSystem.identity),
  instructionsTemplate: ste(oldSystem.instructionsTemplate),
  grid: oldSystem.grid.map((g) => ({
    ...g,
    instructions: steOrNull(g.instructions),
    loopSafety: steOrNull(g.loopSafety),
    toolOutputConventions: steOrNull(g.toolOutputConventions),
  })),
}

describe("byte parity with the core system fixture (P4 STE text)", () => {
  test("the grid has 8 entries", () => expect(system.grid).toHaveLength(8))

  test("each STE rewrite hits the fixture, and no old text is left", () => {
    const all = [
      oldSystem.identity,
      oldSystem.instructionsTemplate,
      ...oldSystem.grid.flatMap((g) => [g.instructions, g.loopSafety, g.toolOutputConventions]),
    ].filter((t): t is string => t !== null)
    for (const [i, rule] of STE_REWRITES.entries()) {
      expect(
        all.some((t) => toSte(t, [rule]).hits === 1),
        `rewrite ${i}`,
      ).toBe(true)
    }
    for (const t of all) expect(toSte(t).text).not.toBe(t)
  })

  test("identity equals the fixture", () => {
    expect(createProvider().identity?.(ctx)).toBe(system.identity)
  })

  test("instructionParts with no ctx gives the instructions template", () => {
    expect(createProvider().instructionParts?.()).toEqual([
      { slot: "instructions", text: system.instructionsTemplate },
    ])
  })

  for (const entry of system.grid) {
    const c = entry.ctx
    const name = `interval=${c.reflectionInterval} cooldownMs=${c.reflectionCooldownMs} blob=${c.blobStoreEnabled}`
    test(`each slot equals the fixture (${name})`, () => {
      const parts = createProvider().instructionParts?.(c) ?? []
      const bySlot = new Map(parts.map((p) => [p.slot, p.text]))
      expect(parts.length).toBe(bySlot.size)
      for (const slot of ["instructions", "loopSafety", "toolOutputConventions"] as const) {
        const want = entry[slot]
        if (want === null) {
          expect(bySlot.has(slot)).toBe(false)
        } else {
          expect(bytes(bySlot.get(slot) ?? "").equals(bytes(want))).toBe(true)
        }
      }
    })
  }

  test("the same provider renders each ctx on its own (no state across calls)", () => {
    const p = createProvider()
    for (const entry of [...system.grid, ...system.grid.toReversed()]) {
      const got = new Map((p.instructionParts?.(entry.ctx) ?? []).map((x) => [x.slot, x.text]))
      expect(got.get("loopSafety") ?? null).toBe(entry.loopSafety)
      expect(got.get("toolOutputConventions") ?? null).toBe(entry.toolOutputConventions)
    }
  })

  test("agentHome comes from the ctx", () => {
    const base = system.grid[0]?.ctx
    if (base === undefined) throw new Error("empty grid")
    const parts = createProvider().instructionParts?.({ ...base, agentHome: "/x/home" }) ?? []
    const text = parts.find((p) => p.slot === "instructions")?.text ?? ""
    expect(text).toBe(system.instructionsTemplate.replaceAll("%%agentHome%%", "/x/home"))
  })

  test("the conventions slot gets agentHome from the ctx", () => {
    const base = system.grid.find((g) => g.ctx.blobStoreEnabled)
    if (base === undefined) throw new Error("no grid entry with blobStoreEnabled")
    const parts = createProvider().instructionParts?.({ ...base.ctx, agentHome: "/x/home" }) ?? []
    const text = parts.find((p) => p.slot === "toolOutputConventions")?.text ?? ""
    expect(text).toContain("`/x/home/sessions/<sid>.blobs/<tool_use_id>.raw`")
    expect(text).not.toContain("%%")
    expect(text).not.toContain("~/.minimal-agent")
  })
})

describe("MA-02 does not promise a transcript file that may not exist", () => {
  test("says the host may keep the transcript in memory, and names SessionInfo", () => {
    const provider = createBaseProvider((name) =>
      readFileSync(join(import.meta.dir, "prompts", name), "utf8"),
    )
    const [part] =
      provider.instructionParts?.({
        reflectionInterval: 50,
        reflectionCooldownMs: 60000,
        blobStoreEnabled: false,
        agentHome: "/home/x",
      }) ?? []
    const text = part?.text ?? ""
    expect(text).toContain("If the host saves the transcript of this session")
    expect(text).toContain("Some hosts keep it only in memory")
    expect(text).toContain("`SessionInfo` gives the session id")
    expect(text).not.toContain(
      "The transcript of this session is `/home/x/sessions/<session_id>.jsonl`",
    )
  })
})
