import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import type { EnabledState, HookStatus } from "./engine.ts"
import { HooksEngine } from "./engine.ts"
import { buildHooksStartupRow, commandBasename, type StartupRow } from "./startup-row.ts"
import { makeSandbox, nativeConfig, type Sandbox } from "./test-support.ts"
import type { TrustState } from "./trust.ts"
import type { CanonicalHook, HookHandlerSpec, HookSupport } from "./types.ts"

/** The design sample (H1-design.md section 2), as the CLI renderer test uses it. */
const SAMPLE: StartupRow = {
  label: "hooks",
  summary: [
    { text: "2 active", tone: "ok" },
    { text: "1 untrusted", tone: "warn" },
  ],
  children: [
    {
      label: "turn.willStart",
      value: [{ text: "timestamp.sh", tone: "accent" }, { text: "before" }],
    },
    {
      label: "tool.willInvoke",
      value: [{ text: "Bash → guard.sh", tone: "accent" }, { text: "claude" }],
    },
    {
      label: "turn.willStop",
      value: [
        { text: "Stop → run-tests.sh", tone: "accent" },
        { text: "claude" },
        { text: "untrusted", tone: "warn" },
      ],
    },
  ],
}

interface FakeOpts {
  channel: string
  dialect?: string
  matcher?: string
  command?: string
  handler?: HookHandlerSpec
  position?: "before" | "after"
  support?: HookSupport
  trust?: TrustState
  enabled?: EnabledState
}

let n = 0
function fake(o: FakeOpts): HookStatus {
  n++
  const hook: CanonicalHook = {
    trustKey: `k${n}`,
    dialect: o.dialect ?? "native",
    source: { id: "user", path: "/x", scope: "user", precedence: 0 },
    channel: o.channel,
    dialectEvent: o.channel,
    ...(o.matcher !== undefined ? { matcher: o.matcher } : {}),
    matches: () => true,
    handler: o.handler ?? { type: "command", command: o.command ?? "run.sh" },
    timeoutMs: 1000,
    async: false,
    failClosed: false,
    ...(o.position ? { position: o.position } : {}),
    support: o.support ?? "ok",
    contentHash: "h",
  }
  return { hook, trust: o.trust ?? "implicit-user", enabled: o.enabled ?? "enabled" }
}

describe("buildHooksStartupRow (fake statuses)", () => {
  test("no hooks gives null", () => {
    expect(buildHooksStartupRow([])).toBeNull()
  })

  test("reproduces the design sample, sorted by channel then source order", () => {
    const rows = [
      fake({
        channel: "turn.willStop",
        dialect: "claude",
        matcher: "Stop",
        command: "./run-tests.sh",
        trust: "untrusted",
      }),
      fake({ channel: "turn.willStart", command: "/a/b/timestamp.sh", position: "before" }),
      fake({ channel: "tool.willInvoke", dialect: "claude", matcher: "Bash", command: "guard.sh" }),
    ]
    expect(buildHooksStartupRow(rows)).toEqual(SAMPLE)
  })

  test("counts active, untrusted and disabled; disabled wins over trust", () => {
    const row = buildHooksStartupRow([
      fake({ channel: "tool.willInvoke", trust: "env" }),
      fake({ channel: "tool.willInvoke", trust: "untrusted-hash" }),
      fake({ channel: "tool.willInvoke", enabled: "disabled", trust: "untrusted" }),
      fake({ channel: "tool.willInvoke", enabled: "disabled-by-config" }),
    ])
    expect(row?.summary).toEqual([
      { text: "1 active", tone: "ok" },
      { text: "1 untrusted", tone: "warn" },
      { text: "2 disabled", tone: "dim" },
    ])
    expect(row?.children?.map((c) => c.value.at(-1))).toEqual([
      { text: "run.sh", tone: "accent" },
      { text: "untrusted", tone: "warn" },
      { text: "disabled", tone: "dim" },
      { text: "disabled", tone: "dim" },
    ])
  })

  test("unsupported and shadowed hooks are left out; only those gives null", () => {
    const only = [
      fake({ channel: "", support: "unsupported-event" }),
      fake({ channel: "tool.willInvoke", support: "unsupported-type" }),
      fake({ channel: "tool.willInvoke", enabled: "shadowed" }),
    ]
    expect(buildHooksStartupRow(only)).toBeNull()
    const row = buildHooksStartupRow([...only, fake({ channel: "turn.willStart" })])
    expect(row?.summary).toEqual([{ text: "1 active", tone: "ok" }])
    expect(row?.children).toHaveLength(1)
  })

  test("matcher * or empty is hidden; HTTP shows the URL host", () => {
    const row = buildHooksStartupRow([
      fake({ channel: "tool.willInvoke", matcher: "*", command: "a.sh" }),
      fake({ channel: "tool.willInvoke", matcher: "", command: "b.sh" }),
      fake({
        channel: "tool.willInvoke",
        matcher: "Edit",
        handler: { type: "http", url: "https://hooks.example.com:8443/x?y=1" },
      }),
    ])
    expect(row?.children?.map((c) => c.value[0]?.text)).toEqual([
      "a.sh",
      "b.sh",
      "Edit → hooks.example.com:8443",
    ])
  })
})

describe("commandBasename", () => {
  test.each([
    ["/usr/local/bin/guard.sh --strict", "guard.sh"],
    ["FOO=1 BAR=2 ./scripts/check.sh", "check.sh"],
    ['"/path with space/run.sh" arg', "run.sh"],
    ["'./q.sh'", "q.sh"],
    ["bash -e ./hooks/guard.sh", "guard.sh"],
    ["/bin/sh -c", "sh"],
    ["python3 tools/lint.py --fix", "lint.py"],
    ["FOO=1 bun run.ts", "run.ts"],
    ["echo hi", "echo"],
    ["/usr/bin/env bash ./x.sh", "x.sh"],
    ["env FOO=1 -i python3 tools/a.py", "a.py"],
    ["env -u HOME -S ./run.sh", "run.sh"],
    ["/usr/bin/env node", "node"],
    ["env", "env"],
    ["bash -c 'echo hi && ./x.sh'", "echo"],
    ['sh -c "/opt/bin/guard.sh --strict"', "guard.sh"],
    ["bash -e -c 'FOO=1 ./y.sh arg'", "y.sh"],
    ["bash -c ''", "bash"],
  ])("%s -> %s", (cmd, want) => {
    expect(commandBasename(cmd)).toBe(want)
  })

  test("exec form uses the command as one word", () => {
    expect(commandBasename("/opt/my tools/run", ["x"])).toBe("run")
    expect(commandBasename("node", ["--x", "/a/hook.js"])).toBe("hook.js")
    expect(commandBasename("/bin/bash", ["-c", "/a/b/c.sh && echo"])).toBe("c.sh")
  })
})

describe("buildHooksStartupRow (real engine)", () => {
  let sb: Sandbox | undefined
  afterEach(() => {
    sb?.cleanup()
    sb = undefined
  })

  test("user native + user claude are active, project claude is untrusted", () => {
    sb = makeSandbox()
    sb.write(
      join(sb.agentHome, "hooks.json"),
      nativeConfig("turn.willStart", [
        { type: "command", command: "/h/timestamp.sh", position: "before" },
      ]),
    )
    const claude = (event: string, command: string, matcher?: string) =>
      JSON.stringify({
        hooks: {
          [event]: [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] }],
        },
      })
    sb.write(join(sb.home, ".claude", "settings.json"), claude("PreToolUse", "guard.sh", "Bash"))
    sb.write(join(sb.project, ".claude", "settings.json"), claude("Stop", "bash run-tests.sh"))
    const eng = new HooksEngine({ cwd: sb.project, env: sb.env })
    expect(buildHooksStartupRow(eng.status())).toEqual({
      label: "hooks",
      summary: [
        { text: "2 active", tone: "ok" },
        { text: "1 untrusted", tone: "warn" },
      ],
      children: [
        {
          label: "turn.willStart",
          value: [{ text: "timestamp.sh", tone: "accent" }, { text: "before" }],
        },
        {
          label: "tool.willInvoke",
          value: [{ text: "Bash → guard.sh", tone: "accent" }, { text: "claude" }],
        },
        {
          label: "turn.willStop",
          value: [
            { text: "run-tests.sh", tone: "accent" },
            { text: "claude" },
            { text: "untrusted", tone: "warn" },
          ],
        },
      ],
    })
  })

  test("no config files gives null", () => {
    sb = makeSandbox()
    const eng = new HooksEngine({ cwd: sb.project, env: sb.env })
    expect(buildHooksStartupRow(eng.status())).toBeNull()
  })
})
