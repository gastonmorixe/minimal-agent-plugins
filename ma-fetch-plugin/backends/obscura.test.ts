import { describe, expect, test } from "bun:test"
import { BackendInputError, buildArgv, parseEnv } from "./obscura.ts"

describe("buildArgv - invariants (always-on)", () => {
  test("--stealth is always present", () => {
    const argv = buildArgv({
      url: "https://example.com",
      format: "markdown",
      waitUntil: "load",
      timeoutSec: 30,
    })
    expect(argv).toContain("--stealth")
  })

  test("--quiet is always present", () => {
    const argv = buildArgv({
      url: "https://example.com",
      format: "markdown",
      waitUntil: "load",
      timeoutSec: 30,
    })
    expect(argv).toContain("--quiet")
  })

  test("argv begins with the 'fetch' subcommand", () => {
    const argv = buildArgv({
      url: "https://example.com",
      format: "markdown",
      waitUntil: "load",
      timeoutSec: 30,
    })
    expect(argv[0]).toBe("fetch")
  })

  test("URL is the final positional argument", () => {
    const argv = buildArgv({
      url: "https://example.com/path?q=1",
      format: "markdown",
      waitUntil: "load",
      timeoutSec: 30,
      selector: "main",
      evalExpr: "document.title",
      userAgent: "Mozilla/5.0",
      proxy: "socks5://127.0.0.1:1080",
    })
    expect(argv[argv.length - 1]).toBe("https://example.com/path?q=1")
  })

  test("--dump receives the format value verbatim", () => {
    const argv = buildArgv({
      url: "https://example.com",
      format: "links",
      waitUntil: "load",
      timeoutSec: 30,
    })
    const dumpIdx = argv.indexOf("--dump")
    expect(dumpIdx).toBeGreaterThanOrEqual(0)
    expect(argv[dumpIdx + 1]).toBe("links")
  })

  test("--timeout receives stringified seconds", () => {
    const argv = buildArgv({
      url: "https://example.com",
      format: "markdown",
      waitUntil: "load",
      timeoutSec: 45,
    })
    const idx = argv.indexOf("--timeout")
    expect(argv[idx + 1]).toBe("45")
  })

  test("--wait-until receives the wait policy value", () => {
    const argv = buildArgv({
      url: "https://example.com",
      format: "markdown",
      waitUntil: "networkidle0",
      timeoutSec: 30,
    })
    const idx = argv.indexOf("--wait-until")
    expect(argv[idx + 1]).toBe("networkidle0")
  })
})

describe("buildArgv - optional flags", () => {
  test("no optional flags when none provided", () => {
    const argv = buildArgv({
      url: "https://example.com",
      format: "markdown",
      waitUntil: "load",
      timeoutSec: 30,
    })
    expect(argv).not.toContain("--selector")
    expect(argv).not.toContain("--eval")
    expect(argv).not.toContain("--user-agent")
    expect(argv).not.toContain("--proxy")
  })

  test("--selector appears only when provided", () => {
    const argv = buildArgv({
      url: "https://example.com",
      format: "markdown",
      waitUntil: "load",
      timeoutSec: 30,
      selector: "article > h1",
    })
    const idx = argv.indexOf("--selector")
    expect(argv[idx + 1]).toBe("article > h1")
  })

  test("--eval appears only when provided", () => {
    const argv = buildArgv({
      url: "https://example.com",
      format: "markdown",
      waitUntil: "load",
      timeoutSec: 30,
      evalExpr: "document.querySelector('h1').textContent",
    })
    const idx = argv.indexOf("--eval")
    expect(argv[idx + 1]).toBe("document.querySelector('h1').textContent")
  })

  test("--user-agent appears only when provided", () => {
    const argv = buildArgv({
      url: "https://example.com",
      format: "markdown",
      waitUntil: "load",
      timeoutSec: 30,
      userAgent: "MyBot/1.0",
    })
    const idx = argv.indexOf("--user-agent")
    expect(argv[idx + 1]).toBe("MyBot/1.0")
  })

  test("--proxy appears only when provided", () => {
    const argv = buildArgv({
      url: "https://example.com",
      format: "markdown",
      waitUntil: "load",
      timeoutSec: 30,
      proxy: "http://corp.proxy:8080",
    })
    const idx = argv.indexOf("--proxy")
    expect(argv[idx + 1]).toBe("http://corp.proxy:8080")
  })

  test("empty-string optional values do NOT produce empty flags", () => {
    const argv = buildArgv({
      url: "https://example.com",
      format: "markdown",
      waitUntil: "load",
      timeoutSec: 30,
      selector: "",
      evalExpr: "",
      userAgent: "",
      proxy: "",
    })
    expect(argv).not.toContain("--selector")
    expect(argv).not.toContain("--eval")
    expect(argv).not.toContain("--user-agent")
    expect(argv).not.toContain("--proxy")
  })
})

describe("buildArgv - security / hygiene", () => {
  test("URL with shell metacharacters is passed as a single argv element (no shell interpolation)", () => {
    // We're producing an argv array, not a shell string. The URL stays
    // exactly one element - when spawn'd via Bun.spawn(argv), no shell is
    // involved, so `;` `&` `|` `$()` are inert.
    const url = "https://example.com/?q=1;rm%20-rf%20/&x=$(whoami)"
    const argv = buildArgv({
      url,
      format: "markdown",
      waitUntil: "load",
      timeoutSec: 30,
    })
    expect(argv).toContain(url)
    expect(argv.filter((s) => s === url).length).toBe(1)
  })

  test("eval expression with quotes survives intact", () => {
    const evalExpr = `document.querySelector('a[href="https://x"]').click()`
    const argv = buildArgv({
      url: "https://example.com",
      format: "markdown",
      waitUntil: "load",
      timeoutSec: 30,
      evalExpr,
    })
    const idx = argv.indexOf("--eval")
    expect(argv[idx + 1]).toBe(evalExpr)
  })
})

describe("parseEnv - required fields", () => {
  test("rejects missing URL", () => {
    expect(() =>
      parseEnv({
        MA_FETCH_FORMAT: "markdown",
        MA_FETCH_WAIT_UNTIL: "load",
        MA_FETCH_TIMEOUT_SEC: "30",
      }),
    ).toThrow(BackendInputError)
  })

  test("rejects missing format", () => {
    expect(() =>
      parseEnv({
        MA_FETCH_URL: "https://example.com",
        MA_FETCH_WAIT_UNTIL: "load",
        MA_FETCH_TIMEOUT_SEC: "30",
      }),
    ).toThrow(/MA_FETCH_FORMAT is required/)
  })

  test("rejects invalid format", () => {
    expect(() =>
      parseEnv({
        MA_FETCH_URL: "https://example.com",
        MA_FETCH_FORMAT: "pdf",
        MA_FETCH_WAIT_UNTIL: "load",
        MA_FETCH_TIMEOUT_SEC: "30",
      }),
    ).toThrow(/must be one of/)
  })

  test("rejects invalid wait-until", () => {
    expect(() =>
      parseEnv({
        MA_FETCH_URL: "https://example.com",
        MA_FETCH_FORMAT: "markdown",
        MA_FETCH_WAIT_UNTIL: "ready",
        MA_FETCH_TIMEOUT_SEC: "30",
      }),
    ).toThrow(/MA_FETCH_WAIT_UNTIL/)
  })

  test("rejects non-numeric timeout", () => {
    expect(() =>
      parseEnv({
        MA_FETCH_URL: "https://example.com",
        MA_FETCH_FORMAT: "markdown",
        MA_FETCH_WAIT_UNTIL: "load",
        MA_FETCH_TIMEOUT_SEC: "soon",
      }),
    ).toThrow(/MA_FETCH_TIMEOUT_SEC/)
  })

  test("rejects out-of-range timeout (too low)", () => {
    expect(() =>
      parseEnv({
        MA_FETCH_URL: "https://example.com",
        MA_FETCH_FORMAT: "markdown",
        MA_FETCH_WAIT_UNTIL: "load",
        MA_FETCH_TIMEOUT_SEC: "0",
      }),
    ).toThrow()
  })

  test("rejects out-of-range timeout (too high)", () => {
    expect(() =>
      parseEnv({
        MA_FETCH_URL: "https://example.com",
        MA_FETCH_FORMAT: "markdown",
        MA_FETCH_WAIT_UNTIL: "load",
        MA_FETCH_TIMEOUT_SEC: "601",
      }),
    ).toThrow()
  })
})

describe("parseEnv - optional fields", () => {
  test("missing optional fields are undefined (not empty strings)", () => {
    const opts = parseEnv({
      MA_FETCH_URL: "https://example.com",
      MA_FETCH_FORMAT: "markdown",
      MA_FETCH_WAIT_UNTIL: "load",
      MA_FETCH_TIMEOUT_SEC: "30",
    })
    expect(opts.selector).toBeUndefined()
    expect(opts.evalExpr).toBeUndefined()
    expect(opts.userAgent).toBeUndefined()
    expect(opts.proxy).toBeUndefined()
  })

  test("empty optional fields are normalized to undefined", () => {
    const opts = parseEnv({
      MA_FETCH_URL: "https://example.com",
      MA_FETCH_FORMAT: "markdown",
      MA_FETCH_WAIT_UNTIL: "load",
      MA_FETCH_TIMEOUT_SEC: "30",
      MA_FETCH_SELECTOR: "   ",
      MA_FETCH_USER_AGENT: "",
      MA_FETCH_PROXY: "  ",
    })
    expect(opts.selector).toBeUndefined()
    expect(opts.userAgent).toBeUndefined()
    expect(opts.proxy).toBeUndefined()
  })

  test("optional fields round-trip when set", () => {
    const opts = parseEnv({
      MA_FETCH_URL: "https://example.com",
      MA_FETCH_FORMAT: "text",
      MA_FETCH_WAIT_UNTIL: "networkidle0",
      MA_FETCH_TIMEOUT_SEC: "60",
      MA_FETCH_SELECTOR: "main",
      MA_FETCH_EVAL: "document.title",
      MA_FETCH_USER_AGENT: "Mozilla/5.0 (Test)",
      MA_FETCH_PROXY: "socks5://127.0.0.1:1080",
    })
    expect(opts).toEqual({
      url: "https://example.com",
      format: "text",
      waitUntil: "networkidle0",
      timeoutSec: 60,
      selector: "main",
      evalExpr: "document.title",
      userAgent: "Mozilla/5.0 (Test)",
      proxy: "socks5://127.0.0.1:1080",
    })
  })

  test("eval expression preserves leading/trailing whitespace (JS may want it)", () => {
    const opts = parseEnv({
      MA_FETCH_URL: "https://example.com",
      MA_FETCH_FORMAT: "markdown",
      MA_FETCH_WAIT_UNTIL: "load",
      MA_FETCH_TIMEOUT_SEC: "30",
      MA_FETCH_EVAL: "  return 1 + 2  ",
    })
    expect(opts.evalExpr).toBe("  return 1 + 2  ")
  })
})
