import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterAll, beforeAll, expect, test } from "bun:test"

import { PluginLoader } from "../node_modules/@minimal-agent/core/src/plugins/loader.ts"
import {
  collectSystemPromptParts,
  resolveBaseIdentity,
} from "../node_modules/@minimal-agent/core/src/plugins/system-prompt-base.ts"

import { toSte } from "./__fixtures__/ste-p4.ts"

const TMP = join(import.meta.dir, "tmp-loader-test")
const FIX = join(import.meta.dir, "__fixtures__")
/** An old core fixture, mapped to the P4 STE text (see `__fixtures__/ste-p4.ts`). */
const steFixture = (name: string) =>
  Buffer.from(toSte(readFileSync(join(FIX, name), "utf-8")).text, "utf-8")
/** The agent home of the test: a fixed value, so the env of the host does not change the bytes. */
const HOME = "/x/home"

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true })
  const dest = join(TMP, "embedded", "plugins", "ma-base-prompt-plugin")
  mkdirSync(dest, { recursive: true })
  for (const f of ["manifest.json", "provider.ts"]) cpSync(join(import.meta.dir, f), join(dest, f))
  cpSync(join(import.meta.dir, "prompts"), join(dest, "prompts"), { recursive: true })
})
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

test("the core loader registers the plugin and serves the STE text with no load failure", async () => {
  const events: { source: string }[] = []
  const loader = await PluginLoader.load({
    embeddedDir: join(TMP, "embedded"),
    roots: { project: [join(TMP, "no-project")] },
    diagnostics: { emit: (e: { source: string }) => events.push(e) } as never,
    disabledPluginIds: new Set(),
    logger: () => {},
  })
  const holder = loader.systemPromptBase()
  expect(holder.entries.map((e) => e.pluginId)).toEqual(["ma-base-prompt-plugin"])
  const id = resolveBaseIdentity(holder, { authKind: "k", modelId: "m" }) ?? ""
  expect(Buffer.from(id).equals(steFixture("old-identity.txt"))).toBe(true)
  // Core renders each part at its point of use (S1) with the expander of the
  // load. This root has no `prompts.template` provider, so the old core rule
  // applies: only `agentHome` is filled. The text is the STE template with
  // the agent home of the ctx, and no token stays.
  expect(holder.expand).toBeDefined()
  const ins = collectSystemPromptParts(holder, { agentHome: HOME }).get("instructions") ?? ""
  const want = steFixture("old-instructions.txt").toString("utf-8")
  expect(want).toContain("%%agentHome%%")
  expect(ins).toBe(want.replaceAll("%%agentHome%%", HOME))
  expect(ins).not.toContain("%%")
  expect(events.filter((e) => e.source === "prompt.system_base_load_failed")).toHaveLength(0)
})
