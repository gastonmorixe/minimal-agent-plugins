import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { defaultConfig, type FetchConfig } from "../lib/config.ts"

import {
  buildDisplayBody,
  buildDisplayFooter,
  formatBytes,
  mergeInputs,
  normalizeMarkdown,
  resolveSessionDir,
  sessionLeafName,
  validateInput,
} from "./fetch.ts"

// ---------------------------------------------------------------------------
// validateInput
// ---------------------------------------------------------------------------

describe("validateInput - url", () => {
  test("rejects missing url", () => {
    const v = validateInput({})
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toMatch(/url/)
  })

  test("rejects non-string url", () => {
    expect(validateInput({ url: 42 }).ok).toBe(false)
    expect(validateInput({ url: null }).ok).toBe(false)
    expect(validateInput({ url: [] }).ok).toBe(false)
  })

  test("rejects whitespace-only url", () => {
    expect(validateInput({ url: "   " }).ok).toBe(false)
  })

  test("rejects non-http(s) schemes", () => {
    for (const bad of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ftp://example.com",
      "data:text/html,<h1>x</h1>",
      "/relative/path",
      "example.com",
    ]) {
      const v = validateInput({ url: bad })
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.error).toMatch(/http/)
    }
  })

  test("accepts http and https", () => {
    expect(validateInput({ url: "http://example.com" }).ok).toBe(true)
    expect(validateInput({ url: "https://example.com" }).ok).toBe(true)
    expect(validateInput({ url: "HTTPS://example.com" }).ok).toBe(true)
  })

  test("trims surrounding whitespace", () => {
    const v = validateInput({ url: "  https://example.com  " })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.url).toBe("https://example.com")
  })

  test("rejects very long url", () => {
    const v = validateInput({ url: `https://example.com/${"a".repeat(5000)}` })
    expect(v.ok).toBe(false)
  })
})

describe("validateInput - format", () => {
  test("accepts each valid format", () => {
    for (const f of ["markdown", "text", "html", "links", "original"]) {
      const v = validateInput({ url: "https://x", format: f })
      expect(v.ok).toBe(true)
      if (v.ok) expect(v.value.format).toBe(f as never)
    }
  })

  test("rejects invalid format", () => {
    const v = validateInput({ url: "https://x", format: "pdf" })
    expect(v.ok).toBe(false)
  })

  test("undefined format leaves value.format undefined", () => {
    const v = validateInput({ url: "https://x" })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.format).toBeUndefined()
  })
})

describe("validateInput - binary", () => {
  test("accepts boolean true/false", () => {
    const t = validateInput({ url: "https://x", binary: true })
    expect(t.ok).toBe(true)
    if (t.ok) expect(t.value.binary).toBe(true)
    const f = validateInput({ url: "https://x", binary: false })
    expect(f.ok).toBe(true)
    if (f.ok) expect(f.value.binary).toBe(false)
  })

  test("rejects non-boolean", () => {
    expect(validateInput({ url: "https://x", binary: "true" }).ok).toBe(false)
    expect(validateInput({ url: "https://x", binary: 1 }).ok).toBe(false)
  })

  test("undefined leaves binary unset", () => {
    const v = validateInput({ url: "https://x" })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.binary).toBeUndefined()
  })
})

describe("validateInput - wait_until", () => {
  test("accepts each valid value", () => {
    for (const w of ["load", "domcontentloaded", "networkidle0"]) {
      const v = validateInput({ url: "https://x", wait_until: w })
      expect(v.ok).toBe(true)
    }
  })

  test("rejects invalid value", () => {
    const v = validateInput({ url: "https://x", wait_until: "ready" })
    expect(v.ok).toBe(false)
  })
})

describe("validateInput - timeout_sec", () => {
  test("accepts integer in [1,120]", () => {
    const v = validateInput({ url: "https://x", timeout_sec: 60 })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.timeoutSec).toBe(60)
  })

  test("floors fractional", () => {
    const v = validateInput({ url: "https://x", timeout_sec: 30.7 })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.timeoutSec).toBe(30)
  })

  test("rejects out-of-range", () => {
    expect(validateInput({ url: "https://x", timeout_sec: 0 }).ok).toBe(false)
    expect(validateInput({ url: "https://x", timeout_sec: 121 }).ok).toBe(false)
    expect(validateInput({ url: "https://x", timeout_sec: -5 }).ok).toBe(false)
  })

  test("rejects non-number", () => {
    expect(validateInput({ url: "https://x", timeout_sec: "30" }).ok).toBe(false)
  })
})

describe("validateInput - selector and eval", () => {
  test("selector trimmed and stored", () => {
    const v = validateInput({ url: "https://x", selector: "  main  " })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.selector).toBe("main")
  })

  test("empty selector is normalized to undefined", () => {
    const v = validateInput({ url: "https://x", selector: "   " })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.selector).toBeUndefined()
  })

  test("eval preserves leading/trailing whitespace (JS may need it)", () => {
    const v = validateInput({ url: "https://x", eval: "  return 1+2  " })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.evalExpr).toBe("  return 1+2  ")
  })

  test("empty-string eval normalizes to undefined", () => {
    const v = validateInput({ url: "https://x", eval: "" })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.evalExpr).toBeUndefined()
  })

  test("non-string selector / eval rejected", () => {
    expect(validateInput({ url: "https://x", selector: 42 }).ok).toBe(false)
    expect(validateInput({ url: "https://x", eval: {} }).ok).toBe(false)
  })

  test("eval_mode accepts value and page only when eval is present", () => {
    for (const mode of ["value", "page"]) {
      const v = validateInput({ url: "https://x", eval: "document.title", eval_mode: mode })
      expect(v.ok).toBe(true)
      if (v.ok) expect(v.value.evalMode).toBe(mode as "value" | "page")
    }
    expect(validateInput({ url: "https://x", eval: "document.title", eval_mode: "raw" }).ok).toBe(
      false,
    )
    expect(validateInput({ url: "https://x", eval_mode: "value" }).ok).toBe(false)
  })

  test("explicit value mode rejects selector; omitted mode leaves inference to mergeInputs", () => {
    expect(
      validateInput({
        url: "https://x",
        selector: "#result",
        eval: "document.body.dataset.ready = '1'",
        eval_mode: "value",
      }).ok,
    ).toBe(false)
    expect(
      validateInput({
        url: "https://x",
        selector: "#result",
        eval: "document.body.dataset.ready = '1'",
      }).ok,
    ).toBe(true)
  })
})

describe("validateInput - cleanup", () => {
  test("accepts 'off' | 'basic' | 'aggressive'", () => {
    for (const level of ["off", "basic", "aggressive"] as const) {
      const v = validateInput({ url: "https://x", cleanup: level })
      expect(v.ok).toBe(true)
      if (v.ok) expect(v.value.cleanup).toBe(level)
    }
  })

  test("rejects unknown levels", () => {
    const v = validateInput({ url: "https://x", cleanup: "extreme" })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toMatch(/cleanup/)
  })

  test("rejects non-string cleanup", () => {
    expect(validateInput({ url: "https://x", cleanup: 1 }).ok).toBe(false)
    expect(validateInput({ url: "https://x", cleanup: {} }).ok).toBe(false)
  })

  test("absent cleanup → undefined (handler falls back to config default)", () => {
    const v = validateInput({ url: "https://x" })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.cleanup).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// mergeInputs
// ---------------------------------------------------------------------------

describe("mergeInputs", () => {
  test("config defaults fill in unset input fields", () => {
    const cfg = defaultConfig()
    const merged = mergeInputs({ url: "https://x" }, cfg)
    expect(merged.format).toBe("markdown")
    // defaultConfig().defaults.waitUntil was switched to "domcontentloaded"
    // (stealth-friendly default for article sites). See JSDoc on defaultConfig.
    expect(merged.waitUntil).toBe("domcontentloaded")
    expect(merged.timeoutSec).toBe(30)
  })

  test("input overrides config defaults", () => {
    const cfg: FetchConfig = {
      ...defaultConfig(),
      defaults: {
        format: "markdown",
        waitUntil: "load",
        timeoutSec: 30,
        cleanup: "basic",
        session: null,
      },
    }
    const merged = mergeInputs(
      { url: "https://x", format: "text", waitUntil: "networkidle0", timeoutSec: 60 },
      cfg,
    )
    expect(merged.format).toBe("text")
    expect(merged.waitUntil).toBe("networkidle0")
    expect(merged.timeoutSec).toBe(60)
  })

  test("selector and evalExpr passed through", () => {
    const merged = mergeInputs(
      { url: "https://x", selector: "main", evalExpr: "document.title" },
      defaultConfig(),
    )
    expect(merged.selector).toBe("main")
    expect(merged.evalExpr).toBe("document.title")
    expect(merged.evalMode).toBe("page")
  })

  test("eval without selector defaults to value mode and explicit mode wins", () => {
    const merged = mergeInputs({ url: "https://x", evalExpr: "document.title" }, defaultConfig())
    expect(merged.evalMode).toBe("value")
    expect(
      mergeInputs(
        { url: "https://x", evalExpr: "document.title", evalMode: "page" },
        defaultConfig(),
      ).evalMode,
    ).toBe("page")
  })
})

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

describe("formatBytes", () => {
  test("bytes under 1 KB", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1023)).toBe("1023 B")
  })

  test("KB range", () => {
    expect(formatBytes(1024)).toBe("1.0 KB")
    expect(formatBytes(13 * 1024)).toBe("13.0 KB")
    expect(formatBytes(13_200)).toBe("12.9 KB")
  })

  test("MB range", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.00 MB")
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.50 MB")
  })
})

describe("buildDisplayBody", () => {
  test("returns first N lines, no gutter (agent adds it)", () => {
    const content = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn"
    const body = buildDisplayBody(content, 5)
    expect(body).toBe("a\nb\nc\nd\ne")
  })

  test("drops a single trailing empty line", () => {
    const body = buildDisplayBody("a\nb\nc\n", 12)
    expect(body).toBe("a\nb\nc")
  })

  test("clamps per-line width with an ellipsis", () => {
    const long = "x".repeat(500)
    const body = buildDisplayBody(long, 1)
    expect(body.endsWith("…")).toBe(true)
    expect(body.length).toBeLessThanOrEqual(301)
  })

  test("(empty response) sentinel when content empty", () => {
    const body = buildDisplayBody("", 12)
    expect(body).toContain("(empty response)")
  })
})

describe("buildDisplayFooter", () => {
  test("contains format, size, line count; never the backend", () => {
    const footer = buildDisplayFooter({
      format: "markdown",
      size: 13_200,
      lineCount: 350,
    })
    expect(footer).toContain("markdown")
    expect(footer).toContain("12.9 KB")
    expect(footer).toContain("350 lines")
    // The Fetch contract is backend-agnostic: the footer must never name
    // the rendering engine.
    expect(footer.toLowerCase()).not.toContain("obscura")
    expect(footer).not.toContain("via ")
    expect(footer).not.toContain(".ts")
  })

  test("includes operator-visible persistent worker PID without naming the engine", () => {
    const footer = buildDisplayFooter({
      format: "markdown",
      size: 100,
      lineCount: 1,
      workerPid: 4321,
    })
    expect(footer).toContain("worker pid: 4321")
    expect(footer.toLowerCase()).not.toContain("obscura")
  })

  test("includes 'preview truncated' marker when set", () => {
    const footer = buildDisplayFooter({
      format: "markdown",
      size: 13_200,
      lineCount: 350,
      truncated: true,
    })
    expect(footer).toContain("preview truncated")
  })
})

// ---------------------------------------------------------------------------
// normalizeMarkdown (whitespace noise stopgap for HTML→markdown converters)
// ---------------------------------------------------------------------------

describe("normalizeMarkdown - shape", () => {
  test("empty string is preserved", () => {
    expect(normalizeMarkdown("")).toBe("")
  })

  test("single line with no trailing newline is unchanged", () => {
    expect(normalizeMarkdown("hello world")).toBe("hello world")
  })

  test("rstrips trailing spaces and tabs per line", () => {
    const input = "foo   \nbar\t\t\nbaz"
    expect(normalizeMarkdown(input)).toBe("foo\nbar\nbaz")
  })

  test("collapses runs of 2+ blank lines into a single blank", () => {
    const input = "a\n\n\n\n\nb"
    expect(normalizeMarkdown(input)).toBe("a\n\nb")
  })

  test("collapses runs of whitespace-only lines (after rstrip)", () => {
    // Tabs/spaces on each line become empty after rstrip; the run
    // then collapses to a single blank.
    const input = "a\n\t\n  \n\t\t\nb"
    expect(normalizeMarkdown(input)).toBe("a\n\nb")
  })

  test("strips leading blank lines", () => {
    expect(normalizeMarkdown("\n\n\nhello")).toBe("hello")
  })

  test("strips trailing blank lines", () => {
    expect(normalizeMarkdown("hello\n\n\n")).toBe("hello")
  })

  test("is idempotent", () => {
    const noisy = "  \n\n\nfoo\n\n\n  \nbar  \n\n"
    const once = normalizeMarkdown(noisy)
    const twice = normalizeMarkdown(once)
    expect(twice).toBe(once)
  })

  test("preserves single blank lines between paragraphs", () => {
    const input = "para 1\n\npara 2\n\npara 3"
    expect(normalizeMarkdown(input)).toBe("para 1\n\npara 2\n\npara 3")
  })
})

describe("normalizeMarkdown - wikipedia-style fixture", () => {
  // Synthesized from the real Wikipedia output captured during the
  // design research (private/research/raw-tool-output/05-wikipedia-markdown.raw):
  // long run of blank + tab-indented blank lines around real content.
  const fixture =
    "[Jump to content](#bodyContent)\n" +
    "\n\t\n\n\t\t\n\n\t\t\t\n\n\t\t\t\t\n\n\t\n\t\n\n" +
    "Main menu\n" +
    "\t\n\t\n\n\t\t\t\t\n\n\t\t\n\n\t\n\n\t\n" +
    "Main menu"

  test("reduces line count by an order of magnitude", () => {
    const before = fixture.split("\n").length
    const after = normalizeMarkdown(fixture).split("\n").length
    expect(before).toBeGreaterThan(20)
    expect(after).toBeLessThanOrEqual(7) // 3 content lines + at most 4 separators
  })

  test("preserves all non-blank content verbatim", () => {
    const normed = normalizeMarkdown(fixture)
    expect(normed).toContain("[Jump to content](#bodyContent)")
    // "Main menu" appears twice in the source: both occurrences
    // must survive (we only collapse blanks, never content lines).
    expect(normed.match(/Main menu/g)?.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Persistence: session validation, resolveSessionDir, footer rendering
// ---------------------------------------------------------------------------

describe("validateInput - session", () => {
  test("undefined leaves value.session undefined", () => {
    const v = validateInput({ url: "https://x" })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.session).toBeUndefined()
  })

  test("empty string is allowed (opt-out sentinel)", () => {
    const v = validateInput({ url: "https://x", session: "" })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.session).toBe("")
  })

  test("valid name accepted verbatim", () => {
    const v = validateInput({ url: "https://x", session: "twitter" })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.session).toBe("twitter")
  })

  test("alnum + dash + underscore accepted", () => {
    const v = validateInput({ url: "https://x", session: "my-session_2" })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.session).toBe("my-session_2")
  })

  test("path-traversal shapes rejected", () => {
    for (const bad of ["..", "../etc", "a/b", "a\\b", "a;b", "a b", ".hidden", "foo.bar"]) {
      const v = validateInput({ url: "https://x", session: bad })
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.error).toMatch(/session/)
    }
  })

  test("non-string rejected", () => {
    expect(validateInput({ url: "https://x", session: 42 }).ok).toBe(false)
    expect(validateInput({ url: "https://x", session: null }).ok).toBe(false)
    expect(validateInput({ url: "https://x", session: ["x"] }).ok).toBe(false)
  })

  test("> 64 chars rejected", () => {
    const tooLong = "a".repeat(65)
    expect(validateInput({ url: "https://x", session: tooLong }).ok).toBe(false)
  })

  test("exactly 64 chars accepted", () => {
    const max = "a".repeat(64)
    const v = validateInput({ url: "https://x", session: max })
    expect(v.ok).toBe(true)
  })
})

describe("resolveSessionDir", () => {
  const cfg: FetchConfig = {
    ...defaultConfig(),
    storageRoot: "/root/sessions",
  }

  test("per-call name wins", () => {
    expect(resolveSessionDir({ url: "https://x", session: "twitter" }, cfg)).toBe(
      "/root/sessions/twitter",
    )
  })

  test("empty per-call session is explicit opt-out (overrides default)", () => {
    const cfgWithDefault: FetchConfig = {
      ...cfg,
      defaults: { ...cfg.defaults, session: "fallback" },
    }
    expect(resolveSessionDir({ url: "https://x", session: "" }, cfgWithDefault)).toBeUndefined()
  })

  test("undefined per-call falls back to config default", () => {
    const cfgWithDefault: FetchConfig = {
      ...cfg,
      defaults: { ...cfg.defaults, session: "fallback" },
    }
    expect(resolveSessionDir({ url: "https://x" }, cfgWithDefault)).toBe("/root/sessions/fallback")
  })

  test("no per-call, no default → undefined (stateless one-shot)", () => {
    expect(resolveSessionDir({ url: "https://x" }, cfg)).toBeUndefined()
  })

  test("per-call always trumps default", () => {
    const cfgWithDefault: FetchConfig = {
      ...cfg,
      defaults: { ...cfg.defaults, session: "fallback" },
    }
    expect(resolveSessionDir({ url: "https://x", session: "explicit" }, cfgWithDefault)).toBe(
      "/root/sessions/explicit",
    )
  })

  test("malicious name (already caught by validate, defense-in-depth here)", () => {
    // resolveSessionDir is also called with config-default values which
    // come from the config loader. Even if a future bug let a bad name
    // through, the pattern recheck blocks the traversal.
    expect(
      resolveSessionDir({ url: "https://x", session: "../etc" as string }, cfg),
    ).toBeUndefined()
  })

  test("uses path.join (cross-platform separator)", () => {
    const got = resolveSessionDir({ url: "https://x", session: "foo" }, cfg)
    expect(got).toBe(join("/root/sessions", "foo"))
  })
})

describe("mergeInputs - storageDir", () => {
  test("propagates session → storageDir on the merged input", () => {
    const cfg: FetchConfig = { ...defaultConfig(), storageRoot: "/root" }
    const merged = mergeInputs({ url: "https://x", session: "twitter" }, cfg)
    expect(merged.storageDir).toBe("/root/twitter")
  })

  test("omits storageDir when no session", () => {
    const cfg: FetchConfig = { ...defaultConfig(), storageRoot: "/root" }
    const merged = mergeInputs({ url: "https://x" }, cfg)
    expect(merged.storageDir).toBeUndefined()
  })

  test("config default session is applied when input omits it", () => {
    const cfg: FetchConfig = {
      ...defaultConfig(),
      storageRoot: "/root",
      defaults: { ...defaultConfig().defaults, session: "main" },
    }
    const merged = mergeInputs({ url: "https://x" }, cfg)
    expect(merged.storageDir).toBe("/root/main")
  })

  test("empty session opts out of default", () => {
    const cfg: FetchConfig = {
      ...defaultConfig(),
      storageRoot: "/root",
      defaults: { ...defaultConfig().defaults, session: "main" },
    }
    const merged = mergeInputs({ url: "https://x", session: "" }, cfg)
    expect(merged.storageDir).toBeUndefined()
  })
})

describe("sessionLeafName", () => {
  test("returns undefined for undefined input", () => {
    expect(sessionLeafName(undefined)).toBeUndefined()
  })

  test("extracts leaf from posix path", () => {
    expect(sessionLeafName("/root/sessions/twitter")).toBe("twitter")
  })

  test("extracts leaf from windows path", () => {
    expect(sessionLeafName("C:\\root\\sessions\\twitter")).toBe("twitter")
  })

  test("strips trailing slash", () => {
    expect(sessionLeafName("/root/sessions/twitter/")).toBe("twitter")
    expect(sessionLeafName("/root/sessions/twitter//")).toBe("twitter")
  })

  test("no separator → whole string", () => {
    expect(sessionLeafName("twitter")).toBe("twitter")
  })
})

describe("buildDisplayFooter - sessionName", () => {
  test("includes session label when set", () => {
    const f = buildDisplayFooter({
      format: "markdown",
      size: 100,
      lineCount: 5,
      sessionName: "twitter",
    })
    // The footer is ANSI-dimmed but the text is intact between escape codes.
    expect(f).toContain("session: twitter")
  })

  test("omits session label when undefined", () => {
    const f = buildDisplayFooter({
      format: "markdown",
      size: 100,
      lineCount: 5,
    })
    expect(f).not.toContain("session:")
  })

  test("omits session label for empty string", () => {
    const f = buildDisplayFooter({
      format: "markdown",
      size: 100,
      lineCount: 5,
      sessionName: "",
    })
    expect(f).not.toContain("session:")
  })
})
