/**
 * Headless bytes of the `Skill` tool (spec S41).
 *
 * The golden file pins the model-facing `content` of every action, so
 * the S41 move of the display palette to `ui/` cannot change model bytes.
 * Without the CLI `ui.setup`, no output field holds an escape byte.
 *
 * Regenerate the golden file only for an intended content change:
 * `UPDATE_GOLDEN=1 bun test handlers/headless-bytes.test.ts`.
 *
 * @module handlers/headless-bytes.test
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import type { TUIContext, TUIResult } from "../lib/types.ts"

import handler from "./skill.ts"

const GOLDEN_PATH = join(import.meta.dir, "headless-bytes.golden.json")
const ESC = String.fromCharCode(0x1b)

let TMP = ""
const savedHome = process.env.HOME
const savedConfig = process.env.MINIMAL_AGENT_CONFIG

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "ma-skills-bytes-"))
  process.env.HOME = join(TMP, "home")
  process.env.MINIMAL_AGENT_CONFIG = join(TMP, "no-config.json")
  const cwd = join(TMP, "cwd")
  const good = join(cwd, ".agents", "skills", "alpha")
  mkdirSync(join(good, "scripts"), { recursive: true })
  writeFileSync(
    join(good, "SKILL.md"),
    "---\nname: alpha\ndescription: The alpha skill.\nlicense: MIT\nallowed-tools: Bash Read\n---\n# Alpha\n\nStep one.\nStep two.\n",
  )
  writeFileSync(join(good, "scripts", "run.sh"), "echo hi\n")
  const broken = join(cwd, ".agents", "skills", "broken")
  mkdirSync(broken, { recursive: true })
  writeFileSync(join(broken, "SKILL.md"), "no frontmatter\n")
})

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true })
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  if (savedConfig === undefined) delete process.env.MINIMAL_AGENT_CONFIG
  else process.env.MINIMAL_AGENT_CONFIG = savedConfig
})

function ctxFor(input: Record<string, unknown>): TUIContext {
  const noop = () => {}
  return {
    trigger: { type: "tool", name: "Skill", input },
    packageDir: join(TMP, "pkg"),
    cwd: join(TMP, "cwd"),
    env: {},
    abort: new AbortController().signal,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    log: {
      emergency: noop,
      alert: noop,
      critical: noop,
      error: noop,
      warn: noop,
      notice: noop,
      info: noop,
      debug: noop,
    },
  } as TUIContext
}

const CASES: Record<string, Record<string, unknown>> = {
  list: { action: "list" },
  info: { action: "info", name: "alpha" },
  read: { action: "read", name: "alpha" },
  missing: { action: "read", name: "nope" },
  invalid: { action: "bogus" },
}

/** Every text field of a result, with the tmp dir replaced by `<TMP>`. */
function fields(r: TUIResult): Record<string, string | boolean | undefined> {
  if (r.kind !== "tool_result") throw new Error(`unexpected result kind ${r.kind}`)
  const norm = (s: string | undefined) => (s === undefined ? undefined : s.split(TMP).join("<TMP>"))
  return {
    content: norm(r.content),
    is_error: r.is_error,
    display: norm(r.display),
    displayHeader: norm(r.displayHeader),
    displayFooter: norm(r.displayFooter),
  }
}

describe("Skill headless bytes (S41)", () => {
  test("model-facing content matches the golden file", async () => {
    const got: Record<string, unknown> = {}
    for (const [name, input] of Object.entries(CASES)) {
      const f = fields(await handler(ctxFor(input)))
      got[name] = { content: f.content, is_error: f.is_error }
    }
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(GOLDEN_PATH)) {
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(got, null, 2)}\n`)
    }
    expect(got).toEqual(JSON.parse(readFileSync(GOLDEN_PATH, "utf-8")))
  })

  test("no output field holds an escape byte without the CLI ui.setup", async () => {
    for (const input of Object.values(CASES)) {
      const f = fields(await handler(ctxFor(input)))
      for (const [k, v] of Object.entries(f)) {
        if (typeof v === "string") expect({ k, esc: v.includes(ESC) }).toEqual({ k, esc: false })
      }
    }
  })
})
