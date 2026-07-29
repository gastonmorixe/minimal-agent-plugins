import { readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { defaultConfig, parseFetchConfig } from "./config.ts"

type ManifestProperty = { default?: unknown }
type FetchManifest = {
  tuis: Array<{
    trigger: { tool: { input_schema: { properties: Record<string, ManifestProperty> } } }
  }>
}

describe("manifest defaults", () => {
  test("wait_until stays aligned with the runtime built-in default", () => {
    const path = join(import.meta.dir, "..", "manifest.json")
    const manifest = JSON.parse(readFileSync(path, "utf8")) as FetchManifest
    const schemaDefault = manifest.tuis[0]?.trigger.tool.input_schema.properties.wait_until?.default

    expect(schemaDefault).toBe(defaultConfig().defaults.waitUntil)
  })

  test("eval_mode has no schema default because runtime inference depends on selector", () => {
    const path = join(import.meta.dir, "..", "manifest.json")
    const manifest = JSON.parse(readFileSync(path, "utf8")) as FetchManifest
    const evalMode = manifest.tuis[0]?.trigger.tool.input_schema.properties.eval_mode

    expect(evalMode?.default).toBeUndefined()
  })
})

describe("defaultConfig", () => {
  test("returns sensible built-in defaults", () => {
    const c = defaultConfig()
    expect(c.enabled).toBe(true)
    expect(c.backend).toBe("obscura")
    expect(c.userAgent).toBeNull()
    expect(c.proxy).toBeNull()
    expect(c.defaults.format).toBe("markdown")
    expect(c.defaults.waitUntil).toBe("domcontentloaded")
    expect(c.defaults.timeoutSec).toBe(30)
    expect(c.defaults.cleanup).toBe("basic")
    expect(c.backends.obscura?.persistent).toBe(true)
    expect(c.backends.obscura?.workerIdleSec).toBe(300)
  })

  test("defaults.backends enables the persistent obscura worker", () => {
    expect(defaultConfig().backends).toEqual({
      obscura: { persistent: true, workerIdleSec: 300 },
    })
  })
})

describe("parseFetchConfig - falls back to defaults on bad input", () => {
  test("null / undefined / non-object", () => {
    expect(parseFetchConfig(null)).toEqual(defaultConfig())
    expect(parseFetchConfig(undefined)).toEqual(defaultConfig())
    expect(parseFetchConfig(42)).toEqual(defaultConfig())
    expect(parseFetchConfig("string")).toEqual(defaultConfig())
    expect(parseFetchConfig([])).toEqual(defaultConfig())
  })

  test("missing plugins block", () => {
    expect(parseFetchConfig({})).toEqual(defaultConfig())
    expect(parseFetchConfig({ plugins: null })).toEqual(defaultConfig())
    expect(parseFetchConfig({ plugins: "wrong" })).toEqual(defaultConfig())
  })

  test("missing plugins['ma-fetch'] block", () => {
    expect(parseFetchConfig({ plugins: {} })).toEqual(defaultConfig())
    expect(parseFetchConfig({ plugins: { "other-plugin": {} } })).toEqual(defaultConfig())
  })

  test("plugins['ma-fetch'] not an object", () => {
    expect(parseFetchConfig({ plugins: { "ma-fetch": "yes" } })).toEqual(defaultConfig())
  })
})

describe("parseFetchConfig - valid top-level fields", () => {
  test("enabled boolean override", () => {
    const c = parseFetchConfig({ plugins: { "ma-fetch": { enabled: false } } })
    expect(c.enabled).toBe(false)
  })

  test("enabled wrong type is ignored", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { enabled: "yes" } },
    })
    expect(c.enabled).toBe(true)
  })

  test("backend string override", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { backend: "playwright" } },
    })
    expect(c.backend).toBe("playwright")
  })

  test("backend with path-traversal characters is rejected", () => {
    for (const bad of ["../etc/passwd", "foo/bar", "a;b", "foo bar", "foo.ts"]) {
      const c = parseFetchConfig({ plugins: { "ma-fetch": { backend: bad } } })
      expect(c.backend).toBe("obscura") // default preserved
    }
  })

  test("backend empty string ignored", () => {
    const c = parseFetchConfig({ plugins: { "ma-fetch": { backend: "   " } } })
    expect(c.backend).toBe("obscura")
  })

  test("userAgent string override", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { userAgent: "MyBot/1.0" } },
    })
    expect(c.userAgent).toBe("MyBot/1.0")
  })

  test("userAgent null is preserved (intentional reset)", () => {
    const c = parseFetchConfig({ plugins: { "ma-fetch": { userAgent: null } } })
    expect(c.userAgent).toBeNull()
  })

  test("proxy string override", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { proxy: "socks5://127.0.0.1:1080" } },
    })
    expect(c.proxy).toBe("socks5://127.0.0.1:1080")
  })
})

describe("parseFetchConfig - defaults block", () => {
  test("accessibility format override", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { defaults: { format: "accessibility" } } },
    })
    expect(c.defaults.format).toBe("accessibility")
  })

  test("format override", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { defaults: { format: "text" } } },
    })
    expect(c.defaults.format).toBe("text")
  })

  test("invalid format keeps the default", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { defaults: { format: "pdf" } } },
    })
    expect(c.defaults.format).toBe("markdown")
  })

  test("waitUntil override", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { defaults: { waitUntil: "networkidle0" } } },
    })
    expect(c.defaults.waitUntil).toBe("networkidle0")
  })

  test("invalid waitUntil keeps the default", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { defaults: { waitUntil: "ready" } } },
    })
    expect(c.defaults.waitUntil).toBe("domcontentloaded")
  })

  test("timeoutSec integer override", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { defaults: { timeoutSec: 60 } } },
    })
    expect(c.defaults.timeoutSec).toBe(60)
  })

  test("timeoutSec is floored to integer", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { defaults: { timeoutSec: 45.7 } } },
    })
    expect(c.defaults.timeoutSec).toBe(45)
  })

  test("timeoutSec out of range keeps the default", () => {
    for (const bad of [-1, 0, 601, 99999]) {
      const c = parseFetchConfig({
        plugins: { "ma-fetch": { defaults: { timeoutSec: bad } } },
      })
      expect(c.defaults.timeoutSec).toBe(30)
    }
  })

  test("partial defaults block merges with built-in defaults", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { defaults: { format: "links" } } },
    })
    expect(c.defaults.format).toBe("links")
    expect(c.defaults.waitUntil).toBe("domcontentloaded")
    expect(c.defaults.timeoutSec).toBe(30)
    expect(c.defaults.cleanup).toBe("basic")
  })

  test("cleanup default override (aggressive)", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { defaults: { cleanup: "aggressive" } } },
    })
    expect(c.defaults.cleanup).toBe("aggressive")
  })

  test("cleanup default override (off)", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { defaults: { cleanup: "off" } } },
    })
    expect(c.defaults.cleanup).toBe("off")
  })

  test("invalid cleanup keeps the default", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { defaults: { cleanup: "extreme" } } },
    })
    expect(c.defaults.cleanup).toBe("basic")
  })
})

describe("parseFetchConfig - per-backend blocks", () => {
  test("obscura.bin extracted into backends['obscura']", () => {
    const c = parseFetchConfig({
      plugins: {
        "ma-fetch": {
          obscura: { bin: "/opt/obscura/bin/obscura" },
        },
      },
    })
    expect(c.backends.obscura?.bin).toBe("/opt/obscura/bin/obscura")
  })

  test("persistent worker settings are parsed and bounded", () => {
    const c = parseFetchConfig({
      plugins: {
        "ma-fetch": {
          obscura: { persistent: false, workerIdleSec: 45.8 },
        },
      },
    })
    expect(c.backends.obscura?.persistent).toBe(false)
    expect(c.backends.obscura?.workerIdleSec).toBe(45)

    for (const bad of [9, 3601, Number.NaN]) {
      const invalid = parseFetchConfig({
        plugins: { "ma-fetch": { obscura: { workerIdleSec: bad } } },
      })
      expect(invalid.backends.obscura?.workerIdleSec).toBe(300)
    }
  })

  test("multiple backends coexist", () => {
    const c = parseFetchConfig({
      plugins: {
        "ma-fetch": {
          obscura: { bin: "/path/obscura" },
          playwright: { bin: "/path/playwright" },
        },
      },
    })
    expect(c.backends.obscura?.bin).toBe("/path/obscura")
    expect(c.backends.playwright?.bin).toBe("/path/playwright")
  })

  test("non-object backend blocks are skipped", () => {
    const c = parseFetchConfig({
      plugins: {
        "ma-fetch": { obscura: "/path/obscura" },
      },
    })
    expect(c.backends.obscura).toEqual({ persistent: true, workerIdleSec: 300 })
  })

  test("known top-level keys are NOT treated as backend blocks", () => {
    const c = parseFetchConfig({
      plugins: {
        "ma-fetch": {
          defaults: { format: "text" },
          obscura: { bin: "/path/obscura" },
        },
      },
    })
    expect(c.backends).not.toHaveProperty("defaults")
    expect(c.backends.obscura?.bin).toBe("/path/obscura")
  })

  test("obscura.extensions extracted as string array", () => {
    const c = parseFetchConfig({
      plugins: {
        "ma-fetch": {
          obscura: {
            bin: "/path/obscura",
            extensions: ["/path/to/bpc.xpi", "/path/to/ublock.crx"],
          },
        },
      },
    })
    expect(c.backends.obscura?.extensions).toEqual(["/path/to/bpc.xpi", "/path/to/ublock.crx"])
  })

  test("extensions: empty / whitespace / non-string entries are dropped", () => {
    const c = parseFetchConfig({
      plugins: {
        "ma-fetch": {
          obscura: {
            extensions: ["/path/ok.xpi", "", "   ", 42, null, "/path/ok2.xpi"],
          },
        },
      },
    })
    expect(c.backends.obscura?.extensions).toEqual(["/path/ok.xpi", "/path/ok2.xpi"])
  })

  test("extensions: empty array yields undefined (no key set)", () => {
    const c = parseFetchConfig({
      plugins: {
        "ma-fetch": {
          obscura: { extensions: [] },
        },
      },
    })
    expect(c.backends.obscura?.extensions).toBeUndefined()
  })

  test("extensions: non-array value is ignored", () => {
    const c = parseFetchConfig({
      plugins: {
        "ma-fetch": {
          obscura: { extensions: "/path/just-a-string.xpi" },
        },
      },
    })
    expect(c.backends.obscura?.extensions).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Persistence: storageRoot + defaults.session
// ---------------------------------------------------------------------------

import { homedir } from "node:os"

import { configPath, defaultStorageRoot, expandHome, SESSION_NAME_PATTERN } from "./config.ts"

describe("expandHome", () => {
  test("expands a bare `~`", () => {
    expect(expandHome("~")).toBe(homedir())
  })

  test("expands `~/...`", () => {
    expect(expandHome("~/foo")).toBe(join(homedir(), "foo"))
    expect(expandHome("~/foo/bar")).toBe(join(homedir(), "foo/bar"))
  })

  test("leaves absolute paths alone", () => {
    expect(expandHome("/abs/path")).toBe("/abs/path")
  })

  test("leaves `~foo` (different user) alone", () => {
    // We don't try to resolve other users' homes — Python `os.path.expanduser`
    // does, but it's a footgun and we don't need it.
    expect(expandHome("~root/foo")).toBe("~root/foo")
  })

  test("leaves relative paths alone (they get filtered by parseFetchConfig)", () => {
    expect(expandHome("foo/bar")).toBe("foo/bar")
  })
})

describe("defaultStorageRoot", () => {
  // These assert the FALLBACK shape, so clear MINIMAL_AGENT_HOME to keep the
  // assertion deterministic regardless of the ambient env (a live agent or a
  // relocated test shell would otherwise pollute it). Restore after.
  let savedHome: string | undefined
  beforeEach(() => {
    savedHome = process.env.MINIMAL_AGENT_HOME
    delete process.env.MINIMAL_AGENT_HOME
  })
  afterEach(() => {
    if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
    else process.env.MINIMAL_AGENT_HOME = savedHome
  })

  test("rooted under user home + .minimal-agent/sessions/fetch", () => {
    expect(defaultStorageRoot()).toBe(join(homedir(), ".minimal-agent", "sessions", "fetch"))
  })

  test("MINIMAL_AGENT_HOME relocates the storage root", () => {
    process.env.MINIMAL_AGENT_HOME = "/tmp/ma-reloc-fetch"
    expect(defaultStorageRoot()).toBe(join("/tmp/ma-reloc-fetch", "sessions", "fetch"))
  })
})

describe("configPath", () => {
  // configPath consults MINIMAL_AGENT_CONFIG first, then the agent home. Clear
  // BOTH so the test exercises the agent-home branch deterministically, and
  // restore after.
  let savedHome: string | undefined
  let savedConfig: string | undefined
  beforeEach(() => {
    savedHome = process.env.MINIMAL_AGENT_HOME
    savedConfig = process.env.MINIMAL_AGENT_CONFIG
    delete process.env.MINIMAL_AGENT_HOME
    delete process.env.MINIMAL_AGENT_CONFIG
  })
  afterEach(() => {
    if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
    else process.env.MINIMAL_AGENT_HOME = savedHome
    if (savedConfig === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = savedConfig
  })

  test("MINIMAL_AGENT_CONFIG override wins verbatim", () => {
    process.env.MINIMAL_AGENT_CONFIG = "/custom/cfg.jsonc"
    expect(configPath()).toBe("/custom/cfg.jsonc")
  })

  test("relocated MINIMAL_AGENT_HOME moves the resolved config path", () => {
    // Use a home that does not exist on disk so the existsSync(jsonc) branch is
    // false and we get the deterministic `config.json` leaf. Either way the
    // path must live under the relocated home, never under the OS home.
    process.env.MINIMAL_AGENT_HOME = "/tmp/ma-reloc-fetch-cfg-does-not-exist"
    const p = configPath()
    expect(p.startsWith("/tmp/ma-reloc-fetch-cfg-does-not-exist/")).toBe(true)
    expect(p).toBe(join("/tmp/ma-reloc-fetch-cfg-does-not-exist", "config.json"))
  })
})

describe("defaultConfig - persistence fields", () => {
  test("storageRoot defaults to ~/.minimal-agent/sessions/fetch", () => {
    expect(defaultConfig().storageRoot).toBe(defaultStorageRoot())
  })

  test("defaults.session defaults to null (stateless one-shot)", () => {
    expect(defaultConfig().defaults.session).toBeNull()
  })
})

describe("parseFetchConfig - storageRoot", () => {
  test("absolute path is accepted verbatim", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { storageRoot: "/abs/sessions" } },
    })
    expect(c.storageRoot).toBe("/abs/sessions")
  })

  test("tilde is expanded to user home", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { storageRoot: "~/my-sessions" } },
    })
    expect(c.storageRoot).toBe(join(homedir(), "my-sessions"))
  })

  test("relative path is rejected (default preserved)", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { storageRoot: "relative/path" } },
    })
    expect(c.storageRoot).toBe(defaultStorageRoot())
  })

  test("empty / whitespace-only is rejected", () => {
    expect(parseFetchConfig({ plugins: { "ma-fetch": { storageRoot: "" } } }).storageRoot).toBe(
      defaultStorageRoot(),
    )
    expect(parseFetchConfig({ plugins: { "ma-fetch": { storageRoot: "   " } } }).storageRoot).toBe(
      defaultStorageRoot(),
    )
  })

  test("wrong type is ignored", () => {
    expect(parseFetchConfig({ plugins: { "ma-fetch": { storageRoot: 42 } } }).storageRoot).toBe(
      defaultStorageRoot(),
    )
  })

  test("storageRoot does NOT become a backend block", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { storageRoot: "/abs/x" } },
    })
    expect(c.backends).not.toHaveProperty("storageRoot")
  })
})

describe("parseFetchConfig - defaults.session", () => {
  test("valid session name is accepted", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { defaults: { session: "twitter" } } },
    })
    expect(c.defaults.session).toBe("twitter")
  })

  test("alnum + dash + underscore are valid", () => {
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { defaults: { session: "my-session_1" } } },
    })
    expect(c.defaults.session).toBe("my-session_1")
  })

  test("path-traversal shapes are rejected", () => {
    for (const bad of ["..", "../etc/passwd", "a/b", "a;b", "foo bar", "foo.bar", ".hidden"]) {
      const c = parseFetchConfig({
        plugins: { "ma-fetch": { defaults: { session: bad } } },
      })
      expect(c.defaults.session).toBeNull()
    }
  })

  test("empty / whitespace-only is rejected (stays null)", () => {
    expect(
      parseFetchConfig({ plugins: { "ma-fetch": { defaults: { session: "" } } } }).defaults.session,
    ).toBeNull()
    expect(
      parseFetchConfig({ plugins: { "ma-fetch": { defaults: { session: "   " } } } }).defaults
        .session,
    ).toBeNull()
  })

  test("wrong type is ignored", () => {
    expect(
      parseFetchConfig({ plugins: { "ma-fetch": { defaults: { session: 42 } } } }).defaults.session,
    ).toBeNull()
  })

  test("names longer than 64 chars are rejected", () => {
    const longName = "a".repeat(65)
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { defaults: { session: longName } } },
    })
    expect(c.defaults.session).toBeNull()
  })

  test("exactly 64 chars accepted", () => {
    const max = "a".repeat(64)
    const c = parseFetchConfig({
      plugins: { "ma-fetch": { defaults: { session: max } } },
    })
    expect(c.defaults.session).toBe(max)
  })
})

describe("SESSION_NAME_PATTERN", () => {
  test("matches alnum-start names with allowed continuation chars", () => {
    for (const ok of ["x", "x_y", "x-y", "abc123", "A-B_2", "1foo"]) {
      expect(SESSION_NAME_PATTERN.test(ok)).toBe(true)
    }
  })

  test("rejects empty, leading non-alnum, slashes, dots, spaces", () => {
    for (const bad of ["", "-x", "_x", ".x", "x.y", "x/y", "x y", "x\\y"]) {
      expect(SESSION_NAME_PATTERN.test(bad)).toBe(false)
    }
  })
})
