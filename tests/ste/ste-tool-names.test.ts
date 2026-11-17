/**
 * s20: a text names a tool only by its wire name.
 *
 * Four parts:
 * 1. The index: a port of the core loader naming rule. It must produce every
 *    name of the widest golden, and it must agree with core.
 * 2. The detector: must-fire and must-quiet tables from R3 section 8.
 * 3. Mutation proof: a broken port and a broken detector each fail a test.
 * 4. The current state: today's offenders in model-facing text and in handler
 *    messages, as a ratchet. A count may only go down. The rewrite takes both
 *    to zero, and then s20 becomes a plain zero-tolerance rule.
 *
 * @module tests/ste/ste-tool-names.test
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import extraRules from "./extra-rules.ts"
import { maskNonProse } from "./ste-rules.ts"
import { allSurfaces, CORE_ROOT, coreSurfaces, PLUGINS_ROOT } from "./surfaces.ts"
import {
  deriveCamelName,
  type EffectiveNameFn,
  effectiveName,
  handlerMessageFindings,
  S20_RULE,
  stringLiterals,
  type ToolNames,
  toolNameFindings,
  wireToolNames,
} from "./tool-names.ts"

/** The widest golden: the built-in tools plus the plugin tools. */
const GOLDEN = join(PLUGINS_ROOT, "tests/request-golden/goldens/plugin-handler-throws.json")

/** Tools that exist only in a test fixture. */
const FIXTURE_ONLY = new Set(["FixtureThrow"])

/** Enabled tools that the golden lead session does not offer, with the reason. */
const NOT_IN_GOLDEN: ReadonlyMap<string, string> = new Map([
  [
    "SubAgentsReportResult",
    "report_result.ts `available` offers it only to a worker (MINIMAL_AGENT_SUBAGENT_RESULT_PATH set)",
  ],
])

/**
 * The tool names in the golden request.
 *
 * @returns Names from `requests[0].tools[]`, without fixture tools.
 */
function goldenNames(): string[] {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as {
    requests: Array<{ tools: Array<{ name: string }> }>
  }
  return (golden.requests[0]?.tools ?? []).map((t) => t.name).filter((n) => !FIXTURE_ONLY.has(n))
}

/**
 * The golden names that an index does not produce.
 *
 * @param index - The index under test.
 * @returns The missing names.
 */
function missingFromIndex(index: ToolNames): string[] {
  return goldenNames().filter((name) => !index.wire.has(name))
}

const INDEX = wireToolNames()

/**
 * Run the detector on one text as a surface would.
 *
 * @param text - Raw text.
 * @param index - Index. Default: the real one.
 * @returns `name -> wire` for each finding.
 */
function fire(text: string, index: ToolNames = INDEX): string[] {
  return toolNameFindings(
    { masked: maskNonProse(text), raw: text, lineOffset: 0, file: "x.md", role: "prose" },
    index,
  ).map((f) => {
    const wire = /use "([^"]+)"/.exec(f.message)?.[1] ?? "?"
    return `${f.snippet}->${wire}`
  })
}

describe("s20 index: the port of the core naming rule", () => {
  test("deriveCamelName matches the core doc examples", () => {
    expect(deriveCamelName("Background Jobs")).toBe("BackgroundJobs")
    expect(deriveCamelName("Sub-agents")).toBe("SubAgents")
    expect(deriveCamelName("Diff Viewer")).toBe("DiffViewer")
  })

  test("every golden tool name is a wire name", () => {
    const names = goldenNames()
    expect(names.length).toBeGreaterThanOrEqual(47)
    expect(missingFromIndex(INDEX)).toEqual([])
  })

  test("the wire names beyond the golden are only from plugins the golden does not load", () => {
    const golden = new Set(goldenNames())
    const extra = [...INDEX.wire].filter((n) => !golden.has(n)).sort()
    const fromDisabled = new Set(INDEX.entries.filter((e) => !e.enabled).map((e) => e.wire))
    // A wire name that is not in the golden must come from a disabled plugin,
    // or be on the list below with a reason. Anything else is a tool that the
    // golden scenario forgot.
    expect(extra.filter((n) => !fromDisabled.has(n) && !NOT_IN_GOLDEN.has(n))).toEqual([])
    console.log(`wire names outside the golden: ${extra.join(", ")}`)
  })

  test("no alias is also a wire name", () => {
    expect([...INDEX.aliasToWire.keys()].filter((a) => INDEX.wire.has(a))).toEqual([])
  })

  test("the renamed tools and their aliases (R2 table)", () => {
    const expected: Record<string, string> = {
      CronCreate: "ScheduleCronCreate",
      CronList: "ScheduleCronList",
      CronDelete: "ScheduleCronDelete",
      CronReschedule: "ScheduleCronReschedule",
      Peers: "IntercomPeers",
      Send: "IntercomSend",
      Inbox: "IntercomInbox",
      ShowDiff: "DiffViewerShowDiff",
      SpawnAgent: "SubAgentsSpawnAgent",
      ReportResult: "SubAgentsReportResult",
      ListAgents: "SubAgentsListAgents",
      AgentStatus: "SubAgentsAgentStatus",
      AgentResult: "SubAgentsAgentResult",
      AgentOutput: "SubAgentsAgentOutput",
      Mailbox: "SubAgentsMailbox",
      StopAgent: "SubAgentsStopAgent",
      CloudStatus: "CloudCloudStatus",
      CloudLogin: "CloudCloudLogin",
      CloudPush: "CloudCloudPush",
    }
    for (const [alias, wire] of Object.entries(expected)) {
      expect(`${alias}->${INDEX.aliasToWire.get(alias)}`).toBe(`${alias}->${wire}`)
    }
  })

  test.if(existsSync(join(CORE_ROOT, "src/plugins/loader/helpers.ts")))(
    "parity: the port gives the same name as core computeEffectiveName for every manifest tool",
    async () => {
      const core = (await import(join(CORE_ROOT, "src/plugins/loader/helpers.ts"))) as {
        computeEffectiveName: EffectiveNameFn
      }
      const manifests = new Map<string, { name?: string; camelName?: string }>()
      const drift: string[] = []
      for (const entry of INDEX.entries) {
        const path = join(PLUGINS_ROOT, entry.plugin, "manifest.json")
        const manifest =
          manifests.get(path) ??
          (JSON.parse(readFileSync(path, "utf8")) as { name?: string; camelName?: string })
        manifests.set(path, manifest)
        const explicit = INDEX.aliasToWire.has(entry.tool) ? undefined : true
        for (const flag of [explicit, undefined, true, false]) {
          const args: Parameters<EffectiveNameFn> = [
            entry.tool,
            flag,
            entry.manifestName,
            manifest.camelName,
          ]
          const ours = JSON.stringify(effectiveName(...args))
          const theirs = JSON.stringify(core.computeEffectiveName(...args))
          if (ours !== theirs) drift.push(`${entry.tool} explicit=${flag}: ${ours} vs ${theirs}`)
        }
      }
      // A camelName override and a perfect collision are not in any manifest
      // today, so they are checked on synthetic input.
      const synthetic: Array<Parameters<EffectiveNameFn>> = [
        ["Status", undefined, "Cloud", "Cl"],
        ["DiffViewerShow", undefined, "Diff Viewer", undefined],
        ["X", undefined, "a-b c", undefined],
      ]
      for (const args of synthetic) {
        const ours = JSON.stringify(effectiveName(...args))
        const theirs = JSON.stringify(core.computeEffectiveName(...args))
        if (ours !== theirs) drift.push(`${args.join(",")}: ${ours} vs ${theirs}`)
      }
      expect(INDEX.entries.length).toBeGreaterThan(40)
      expect(drift).toEqual([])
    },
  )
})

describe("s20 detector (R3 section 8)", () => {
  const MUST_FIRE: ReadonlyArray<readonly [string, string[]]> = [
    [
      "Do not use it to list a task, use CronList or CronDelete for that.",
      ["CronList->ScheduleCronList", "CronDelete->ScheduleCronDelete"],
    ],
    [
      "Do not use it to delay a task, use `CronReschedule`.",
      ["CronReschedule->ScheduleCronReschedule"],
    ],
    [
      "Do not use it to create a task, use CronCreate for that.",
      ["CronCreate->ScheduleCronCreate"],
    ],
    ["Do not use it to reach a sub-agent worker: use Mailbox.", ["Mailbox->SubAgentsMailbox"]],
    [
      "A read-only type gives the files through the ReportResult `deliverables`.",
      ["ReportResult->SubAgentsReportResult"],
    ],
    ["Call `SpawnAgent`.", ["SpawnAgent->SubAgentsSpawnAgent"]],
    ["Use `ScheduleCronCreated` for that.", ["ScheduleCronCreated->ScheduleCronCreate"]],
    ["Example: CloudStatus({}).", ["CloudStatus->CloudCloudStatus"]],
    ["Send to a separate session with `Send`.", ["Send->IntercomSend"]],
    ["The Send tool delivers a message.", ["Send->IntercomSend"]],
    ["Reply with Send if you need to.", ["Send->IntercomSend"]],
    ["Exposes a ShowDiff tool.", ["ShowDiff->DiffViewerShowDiff"]],
    ["`CronList` shows their tasks.", ["CronList->ScheduleCronList"]],
    ["Run Peers to see who is online.", ["Peers->IntercomPeers"]],
    ["Read the `Inbox` tool.", ["Inbox->IntercomInbox"]],
    [
      "Deliver each file through `ReportResult.deliverables`.",
      ["ReportResult->SubAgentsReportResult"],
    ],
    ["```\nReportResult({\n```", ["ReportResult->SubAgentsReportResult"]],
    ["Use `SubAgentsSpawnAgents` to delegate.", ["SubAgentsSpawnAgents->SubAgentsSpawnAgent"]],
    ["Then use SubAgentsWait for it.", ["SubAgentsWait->?"]],
  ]

  const MUST_QUIET: ReadonlyArray<readonly [string, string]> = [
    ["Use ScheduleCronList or `ScheduleCronList`.", "wire name"],
    ["Use Read. Use Fetch instead. Use `Task`.", "wire names that are English words"],
    ["Send a message to one peer.", "Send as a verb at a sentence start"],
    ["Then Send the file. You can Send it later.", "Send as a verb mid-sentence"],
    ["Drive Chrome over the DevTools Protocol.", "CamelCase that is not tool-shaped"],
    ["Run JavaScript in `TextEdit` and save a WebP on macOS.", "not tool-shaped"],
    ["Find an `AXButton` and read its `TargetInfo`.", "TN, not tool-shaped"],
    ["unread since your last Inbox read", "one-hump alias without a reference context"],
    ["Peers and teams can share a session.", "one-hump alias as a plain noun"],
    ["Read the inbox and the mailbox.", "lowercase"],
    ["Use the GitHub API and the OpenAI SDK.", "CamelCase product names"],
    ["Call SubAgentsReportResult, then IntercomSend.", "wire names"],
    ["Set `aliasToWire` with a `ToolNameIndex`.", "code identifiers"],
  ]

  for (const [text, expected] of MUST_FIRE) {
    test(`fires: ${JSON.stringify(text)}`, () => {
      expect(fire(text)).toEqual(expected)
    })
  }
  for (const [text, why] of MUST_QUIET) {
    test(`quiet (${why}): ${JSON.stringify(text)}`, () => {
      expect(fire(text)).toEqual([])
    })
  }

  test("a finding has the s20 id, error severity, the line and the message", () => {
    const findings = toolNameFindings(
      {
        masked: maskNonProse("One.\nTwo, use CronList."),
        raw: "One.\nTwo, use CronList.",
        lineOffset: 10,
        file: "a.md",
        role: "tool",
      },
      INDEX,
    )
    expect(findings).toEqual([
      {
        rule: S20_RULE,
        message: `"CronList" is not a tool name the model sees; use "ScheduleCronList"`,
        snippet: "CronList",
        line: 12,
        severity: "error",
        offset: 14,
        role: "tool",
      },
    ])
  })

  test("the rule fires in every role (zero-tolerance)", () => {
    for (const role of ["tool", "param", "prose"] as const) {
      const raw = "use CronList"
      const findings = toolNameFindings({ masked: raw, raw, lineOffset: 0, file: "a", role }, INDEX)
      expect(findings.map((f) => f.severity)).toEqual(["error"])
    }
  })
})

describe("extra-rules.ts (loaded by ste-check.ts)", () => {
  test("the default export gives the s20 and the s19 findings for one text", () => {
    const raw = "Do not use it, use CronList for that. Utilize the frobnicator."
    const args = {
      masked: maskNonProse(raw),
      raw,
      lineOffset: 4,
      file: "a.md",
      role: "tool" as const,
    }
    const found = extraRules(args).map((f) => `${f.rule}:${f.line}:${f.snippet}`)
    // s20 comes first: the alias is not a wire name.
    expect(found[0]).toBe(`${S20_RULE}:5:CronList`)
    // s19 follows: one unapproved word and one unknown word.
    const s19 = found.filter((line) => line.startsWith("ste-s19-dictionary:"))
    expect(s19.map((line) => line.split(":")[2]?.toLowerCase())).toEqual(["utilize", "frobnicator"])
  })
})

describe("s20 handler messages: string literals in plugin code", () => {
  test("the literal reader finds strings and templates, not comments or regexes", () => {
    const source = [
      "// Use CronList in a comment",
      "/* call ReportResult */",
      'const a = "Use CronList to see ids."',
      "const b = `Pull it with AgentResult ${id}. ${x ? `nested ${y}` : 'inner'}`",
      "const r = /ReportResult\\s/",
      "const c = 'one'",
    ].join("\n")
    expect(stringLiterals(source).map((l) => `${l.line}:${l.text}`)).toEqual([
      "3:Use CronList to see ids.",
      "4:nested ${y}",
      "4:inner",
      "4:Pull it with AgentResult ${id}. ${x ? `nested ${y}` : 'inner'}",
      "6:one",
    ])
  })
})

describe("s20 handler messages: fire and quiet", () => {
  const SOURCE = [
    'const RESULT_TOOLS = ["SubAgentsReportResult", "ReportResult"]',
    'if (name === "CronList") return',
    'const a = { content: "CronList: wrong trigger", is_error: true }',
    "const b = `ReportResult: failed to write ${p}. Call ReportResult again.`",
    'const c = "No task with that id. Use CronList to see current ids."',
    "const d = `Track it with ListAgents or AgentStatus ${id}.`",
    'const e = "Send a message to the peer."',
    'const f = "Use ScheduleCronList to see ids."',
    "// Use CronList in a comment",
    "const g = 'ReportResult.'",
  ].join("\n")

  test("only human text that names an alias fires, never an identifier", () => {
    const root = mkdtempSync(join(tmpdir(), "s20-handlers-"))
    try {
      mkdirSync(join(root, "ma-x-plugin", "handlers"), { recursive: true })
      mkdirSync(join(root, "ma-x-plugin", "lib"), { recursive: true })
      writeFileSync(join(root, "ma-x-plugin", "handlers", "x.ts"), SOURCE)
      writeFileSync(join(root, "ma-x-plugin", "lib", "x.test.ts"), 'const t = "use CronList"')
      const found = handlerMessageFindings(root, INDEX).map((f) => `${f.line}:${f.name}`)
      expect(found).toEqual([
        "4:ReportResult",
        "5:CronList",
        "6:ListAgents",
        "6:AgentStatus",
        "10:ReportResult",
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("s20 mutation proof", () => {
  test("a port that ignores explicitName fails the golden parity", () => {
    const broken: EffectiveNameFn = (tool, _explicit, manifestName, camelName) =>
      effectiveName(tool, undefined, manifestName, camelName)
    expect(missingFromIndex(wireToolNames(PLUGINS_ROOT, broken)).length).toBeGreaterThan(0)
  })

  test("a port that never adds a prefix fails the golden parity", () => {
    const broken: EffectiveNameFn = (tool) => ({ canonical: tool, migrationAlias: null })
    expect(missingFromIndex(wireToolNames(PLUGINS_ROOT, broken))).toContain("ScheduleCronList")
  })

  test("a port that splits on spaces only fails the golden parity", () => {
    const broken: EffectiveNameFn = (tool, explicit, manifestName) =>
      explicit === true
        ? { canonical: tool, migrationAlias: null }
        : {
            canonical: `${manifestName
              .split(" ")
              .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
              .join("")}${tool}`,
            migrationAlias: tool,
          }
    expect(missingFromIndex(wireToolNames(PLUGINS_ROOT, broken))).toContain("SubAgentsSpawnAgent")
  })

  test("a detector without the alias map misses the aliases", () => {
    const blind: ToolNames = { ...INDEX, aliasToWire: new Map() }
    expect(fire("use CronList or CronDelete for that", blind)).toEqual([])
    expect(fire("use CronList or CronDelete for that")).toHaveLength(2)
  })

  test("a detector that treats every name as wire fires on nothing", () => {
    const all: ToolNames = {
      ...INDEX,
      wire: new Set([...INDEX.wire, ...INDEX.aliasToWire.keys(), "ScheduleCronCreated"]),
    }
    expect(fire("Call `SpawnAgent`. Use `ScheduleCronCreated`.", all)).toEqual([])
    expect(fire("Call `SpawnAgent`. Use `ScheduleCronCreated`.")).toHaveLength(2)
  })

  test("without the loader prefixes an unknown prefixed name is missed", () => {
    const noPrefix: ToolNames = { ...INDEX, prefixes: new Set() }
    expect(fire("Then use SubAgentsWait for it.", noPrefix)).toEqual([])
    expect(fire("Then use SubAgentsWait for it.")).toEqual(["SubAgentsWait->?"])
  })
})

// ---------------------------------------------------------------------------
// The current state. The rewrite takes both tables to zero.
// ---------------------------------------------------------------------------

/**
 * Today's s20 offenders in model-facing surfaces, `file|alias -> count`,
 * measured 2026-11-17. A count may go down, never up. Line numbers are not in
 * the key, so an edit above an offender does not break the test.
 * `ma-ask-mode-plugin/manifest.json` (`refusalHint`) is listed before the
 * engine adds that surface.
 */
const KNOWN_SURFACE_OFFENDERS: Readonly<Record<string, number>> = {
  "ma-agent-cloud/PROMPT.md|CloudLogin": 1,
  "ma-agent-cloud/PROMPT.md|CloudStatus": 1,
  "ma-agent-cloud/manifest.json|CloudLogin": 2,
  "ma-agent-cloud/manifest.json|CloudPush": 1,
  "ma-agent-cloud/manifest.json|CloudStatus": 2,
  "ma-ask-mode-plugin/manifest.json|ShowDiff": 1,
  "ma-diff-view-plugin/manifest.json|ShowDiff": 1,
  "ma-intercom-plugin/PROMPT.md|Send": 1,
  "ma-intercom-plugin/manifest.json|Mailbox": 1,
  "ma-schedule-plugin/PROMPT.md|CronDelete": 1,
  "ma-schedule-plugin/PROMPT.md|CronList": 1,
  "ma-schedule-plugin/manifest.json|CronCreate": 1,
  "ma-schedule-plugin/manifest.json|CronDelete": 2,
  "ma-schedule-plugin/manifest.json|CronList": 1,
  "ma-schedule-plugin/manifest.json|CronReschedule": 2,
  "ma-sub-agents-plugin/lib/library.ts|ReportResult": 6,
  "ma-sub-agents-plugin/manifest.json|ReportResult": 1,
  "ma-sub-agents-plugin/prompts/leaf-discipline.md|ReportResult": 2,
  "ma-sub-agents-plugin/prompts/leaf-discipline.md|SpawnAgent": 1,
  "ma-sub-agents-plugin/prompts/result-contract.tmpl.md|ReportResult": 2,
  "ma-sub-agents-plugin/prompts/result-protocol.tmpl.md|ReportResult": 6,
  "ma-sub-agents-plugin/prompts/result-protocol.tmpl.md|SpawnAgent": 1,
}

/**
 * Today's s20 offenders in handler and lib string literals,
 * `file|alias -> count`, measured 2026-11-17. A count may go down, never up.
 */
const KNOWN_HANDLER_OFFENDERS: Readonly<Record<string, number>> = {
  "ma-agent-cloud/handlers/login.ts|CloudLogin": 1,
  "ma-agent-cloud/handlers/login.ts|CloudStatus": 1,
  "ma-agent-cloud/handlers/push.ts|CloudLogin": 1,
  "ma-agent-cloud/handlers/status.ts|CloudLogin": 1,
  "ma-intercom-plugin/handlers/peers.ts|Peers": 1,
  "ma-intercom-plugin/handlers/send.ts|Peers": 1,
  "ma-intercom-plugin/lib/beat.ts|Send": 1,
  "ma-schedule-plugin/handlers/cron_create.ts|CronDelete": 1,
  "ma-schedule-plugin/handlers/cron_delete.ts|CronList": 1,
  "ma-schedule-plugin/handlers/cron_reschedule.ts|CronList": 1,
  "ma-sub-agents-plugin/handlers/report_result.ts|AgentResult": 1,
  "ma-sub-agents-plugin/handlers/report_result.ts|ReportResult": 5,
  "ma-sub-agents-plugin/handlers/spawn_agent.ts|AgentResult": 1,
  "ma-sub-agents-plugin/handlers/spawn_agent.ts|AgentStatus": 1,
  "ma-sub-agents-plugin/handlers/spawn_agent.ts|ListAgents": 1,
  "ma-sub-agents-plugin/lib/attachment.ts|AgentResult": 2,
  "ma-sub-agents-plugin/lib/attachment.ts|ListAgents": 1,
  "ma-sub-agents-plugin/lib/content.ts|AgentResult": 1,
  "ma-sub-agents-plugin/lib/content.ts|AgentStatus": 1,
  "ma-sub-agents-plugin/lib/content.ts|SpawnAgent": 1,
  "ma-sub-agents-plugin/lib/guard.ts|AgentResult": 1,
  "ma-sub-agents-plugin/lib/guard.ts|ReportResult": 1,
  "ma-sub-agents-plugin/lib/guard.ts|StopAgent": 1,
  "ma-sub-agents-plugin/lib/library.ts|ReportResult": 6,
  "ma-sub-agents-plugin/lib/render.ts|AgentResult": 1,
  "ma-sub-agents-plugin/lib/render.ts|SpawnAgent": 1,
  "ma-sub-agents-plugin/lib/report.ts|ReportResult": 5,
  "ma-sub-agents-plugin/lib/supervisor.ts|AgentResult": 3,
  "ma-sub-agents-plugin/lib/widget.ts|AgentResult": 1,
  "ma-sub-agents-plugin/lib/widget.ts|ListAgents": 1,
}

/** One row of the current-state table. */
interface Offender {
  where: string
  name: string
  wire: string
}

/**
 * Compare today's offenders with a known table: a key must be known and its
 * count must not grow.
 *
 * @param rows - Today's offenders.
 * @param known - The known table.
 * @returns A line for each growth.
 */
function growth(rows: readonly Offender[], known: Readonly<Record<string, number>>): string[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = `${row.where.replace(/:\d+$/, "")}|${row.name}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts]
    .filter(([key, count]) => count > (known[key] ?? 0))
    .map(([key, count]) => `${key}: ${count} > known ${known[key] ?? 0}`)
}

/**
 * Print a table of offenders.
 *
 * @param title - Table title.
 * @param rows - The rows.
 */
function printTable(title: string, rows: readonly Offender[]): void {
  const width = Math.max(10, ...rows.map((r) => r.where.length))
  const lines = rows.map((r) => `  ${r.where.padEnd(width)}  ${r.name.padEnd(15)} -> ${r.wire}`)
  console.log(`\n${title}: ${rows.length}\n${lines.join("\n")}`)
}

/**
 * s20 offenders in every surface today.
 *
 * @returns One row per finding.
 */
function surfaceOffenders(): Offender[] {
  const rows: Offender[] = []
  for (const surface of [...allSurfaces(PLUGINS_ROOT), ...coreSurfaces(CORE_ROOT)]) {
    const findings = toolNameFindings(
      {
        masked: maskNonProse(surface.text),
        raw: surface.text,
        lineOffset: surface.line - 1,
        file: surface.file,
        role: "prose",
      },
      INDEX,
    )
    for (const f of findings) {
      rows.push({
        where: `${surface.file}:${f.line}`,
        name: f.snippet,
        wire: /use "([^"]+)"/.exec(f.message)?.[1] ?? "?",
      })
    }
  }
  return rows
}

describe("s20 current state", () => {
  test("tool names: offenders (fixed by the rewrite)", () => {
    const rows = surfaceOffenders()
    printTable("s20 offenders in model-facing surfaces", rows)
    const known = Object.values(KNOWN_SURFACE_OFFENDERS).reduce((a, b) => a + b, 0)
    console.log(`known ${known}, now ${rows.length}, fixed ${known - rows.length}`)
    // No new offender. When this list is empty, delete the table and make s20
    // a plain zero-tolerance rule.
    expect(growth(rows, KNOWN_SURFACE_OFFENDERS)).toEqual([])
  })

  test("tool names: handler message offenders (fixed by the rewrite)", () => {
    const rows = handlerMessageFindings(PLUGINS_ROOT, INDEX).map((f) => ({
      where: `${f.file}:${f.line}`,
      name: f.name,
      wire: f.wire ?? "?",
    }))
    printTable("s20 offenders in handler and lib string literals", rows)
    const known = Object.values(KNOWN_HANDLER_OFFENDERS).reduce((a, b) => a + b, 0)
    console.log(`known ${known}, now ${rows.length}, fixed ${known - rows.length}`)
    expect(growth(rows, KNOWN_HANDLER_OFFENDERS)).toEqual([])
  })

  test("the current-state ratchet catches a new offender", () => {
    const planted: Offender[] = [{ where: "ma-x/PROMPT.md:1", name: "CronList", wire: "x" }]
    expect(growth(planted, KNOWN_SURFACE_OFFENDERS)).toEqual([
      "ma-x/PROMPT.md|CronList: 1 > known 0",
    ])
  })
})
