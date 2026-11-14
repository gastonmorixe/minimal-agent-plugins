import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterAll, beforeAll, expect, test } from "bun:test"

import { PluginLoader } from "../../minimal-agent-core/src/plugins/loader.ts"
import {
  collectSystemPromptParts,
  resolveBaseIdentity,
} from "../../minimal-agent-core/src/plugins/system-prompt-base.ts"

const TMP = join(import.meta.dir, "tmp-loader-test")
const FIX = join(import.meta.dir, "__fixtures__")

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true })
  const dest = join(TMP, "embedded", "plugins", "ma-base-prompt-plugin")
  mkdirSync(dest, { recursive: true })
  for (const f of ["manifest.json", "provider.ts"]) cpSync(join(import.meta.dir, f), join(dest, f))
  cpSync(join(import.meta.dir, "prompts"), join(dest, "prompts"), { recursive: true })
})
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

test("the core loader registers the plugin and serves the old bytes with no load failure", async () => {
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
  expect(Buffer.from(id).equals(readFileSync(join(FIX, "old-identity.txt")))).toBe(true)
  const ins = collectSystemPromptParts(holder).get("instructions") ?? ""
  expect(Buffer.from(ins).equals(readFileSync(join(FIX, "old-instructions.txt")))).toBe(true)
  expect(events.filter((e) => e.source === "prompt.system_base_load_failed")).toHaveLength(0)
})
