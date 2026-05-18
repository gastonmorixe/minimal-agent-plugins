import { describe, expect, test } from "bun:test"
import { defaultConfig, parseFetchConfig } from "./config.ts"

describe("defaultConfig", () => {
  test("returns sensible built-in defaults", () => {
    const c = defaultConfig()
    expect(c.enabled).toBe(true)
    expect(c.backend).toBe("obscura")
    expect(c.userAgent).toBeNull()
    expect(c.proxy).toBeNull()
    expect(c.defaults.format).toBe("markdown")
    expect(c.defaults.waitUntil).toBe("load")
    expect(c.defaults.timeoutSec).toBe(30)
  })

  test("defaults.backends is empty (no per-backend overrides by default)", () => {
    expect(defaultConfig().backends).toEqual({})
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
    expect(parseFetchConfig({ plugins: { "other-plugin": {} } })).toEqual(
      defaultConfig(),
    )
  })

  test("plugins['ma-fetch'] not an object", () => {
    expect(parseFetchConfig({ plugins: { "ma-fetch": "yes" } })).toEqual(
      defaultConfig(),
    )
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
    expect(c.defaults.waitUntil).toBe("load")
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
    expect(c.defaults.waitUntil).toBe("load")
    expect(c.defaults.timeoutSec).toBe(30)
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
    expect(c.backends.obscura).toBeUndefined()
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
})
