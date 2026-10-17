import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { makeFixtureDir, removeFixtureDir } from "../test-support.ts"

import * as FS from "./fs.ts"
import {
  appendFileIn,
  readFdCapped,
  readRegularFileIn,
  readUserFileCapped,
  removeFileIn,
  renameFileIn,
  writeFileIn,
} from "./fs.ts"

/** Text of root/rel via the one safe read. Throws in the test on an error. */
function readText(base: string, rel: string, cap = 1 << 20): string {
  const r = readRegularFileIn(base, rel, cap)
  if ("error" in r) throw new Error(r.error)
  return r.value?.text ?? ""
}

let root = ""
let outside = ""

beforeEach(() => {
  root = makeFixtureDir("fs-root-")
  outside = makeFixtureDir("fs-out-")
})
afterEach(() => {
  removeFixtureDir(root)
  removeFixtureDir(outside)
})

describe("writeFileIn", () => {
  it("normal write: mode 0600, atomic, no temp left", () => {
    const r = writeFileIn(root, "a/b.txt", "hello", { mode: 0o600 })
    expect(r).toEqual({ ok: true })
    const p = join(root, "a", "b.txt")
    expect(readFileSync(p, "utf8")).toBe("hello")
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(root, "a"))).toEqual(["b.txt"])
  })

  it("default mode is 0600 and replace works", () => {
    expect(writeFileIn(root, "x.txt", "one")).toEqual({ ok: true })
    expect(writeFileIn(root, "x.txt", "two")).toEqual({ ok: true })
    expect(readFileSync(join(root, "x.txt"), "utf8")).toBe("two")
    expect(statSync(join(root, "x.txt")).mode & 0o777).toBe(0o600)
  })

  it("exclusive write fails on an existing target", () => {
    expect(writeFileIn(root, "e.txt", "one", { exclusive: true })).toEqual({ ok: true })
    expect(writeFileIn(root, "e.txt", "two", { exclusive: true })).toEqual({ error: "exists" })
    expect(readFileSync(join(root, "e.txt"), "utf8")).toBe("one")
  })

  it("refuses a `..` escape", () => {
    expect(writeFileIn(root, "../esc.txt", "x")).toEqual({ error: "path escapes root" })
    expect(writeFileIn(root, "a/../../esc.txt", "x")).toEqual({ error: "path escapes root" })
  })

  it("refuses an absolute path outside root, allows one inside", () => {
    expect(writeFileIn(root, join(outside, "abs.txt"), "x")).toEqual({
      error: "path escapes root",
    })
    expect(readdirSync(outside)).toEqual([])
    expect(writeFileIn(root, join(root, "in.txt"), "x")).toEqual({ ok: true })
  })

  it("refuses a parent dir symlink that resolves outside root", () => {
    symlinkSync(outside, join(root, "link"))
    expect(writeFileIn(root, "link/new.txt", "x")).toEqual({ error: "path escapes root" })
    expect(readdirSync(outside)).toEqual([])
  })

  it("refuses a final target that is a symlink (even inside root)", () => {
    writeFileSync(join(root, "real.txt"), "keep")
    symlinkSync(join(root, "real.txt"), join(root, "sym.txt"))
    expect(writeFileIn(root, "sym.txt", "x")).toEqual({ error: "target is a symlink" })
    expect(readFileSync(join(root, "real.txt"), "utf8")).toBe("keep")
  })

  it("refuses a root that is not a real directory", () => {
    writeFileSync(join(root, "file"), "f")
    expect(writeFileIn(join(root, "file"), "x.txt", "x")).toEqual({ error: "bad root" })
    expect(writeFileIn(join(root, "missing"), "x.txt", "x")).toEqual({ error: "bad root" })
    symlinkSync(outside, join(root, "rootlink"))
    expect(writeFileIn(join(root, "rootlink"), "x.txt", "x")).toEqual({ error: "bad root" })
  })

  it("never throws on bad input", () => {
    expect(writeFileIn(root, "", "x")).toEqual({ error: "bad path" })
    expect(writeFileIn(root, "a\0b", "x")).toEqual({ error: "bad path" })
    expect(writeFileIn(null as unknown as string, "x", "x")).toEqual({ error: "bad root" })
  })
})

describe("fix4 (N6): readFileIn is gone", () => {
  it("fs.ts no longer exports readFileIn (only tests used it)", () => {
    expect("readFileIn" in FS).toBe(false)
  })
})

describe("readRegularFileIn (fix2)", () => {
  it("returns text, uid and mode bits from one fd", () => {
    writeFileSync(join(root, "k.txt"), "abc", { mode: 0o600 })
    const r = readRegularFileIn(root, "k.txt", 10)
    expect("ok" in r && r.value?.text).toBe("abc")
    expect("ok" in r && r.value?.mode).toBe(0o600)
    expect("ok" in r && r.value?.uid).toBe(statSync(join(root, "k.txt")).uid)
    expect(readRegularFileIn(root, "k.txt", 2)).toEqual({ error: "too big" })
    expect(readRegularFileIn(root, "none.txt", 10)).toEqual({ error: "missing" })
  })

  it("refuses a symlink, a dir, and the 3 root escapes", () => {
    writeFileSync(join(outside, "o.txt"), "secret-ish")
    symlinkSync(join(outside, "o.txt"), join(root, "s.txt"))
    expect(readRegularFileIn(root, "s.txt", 100)).toEqual({ error: "target is a symlink" })
    mkdirSync(join(root, "d"))
    expect(readRegularFileIn(root, "d", 100)).toEqual({ error: "not a file" })
    expect(readRegularFileIn(root, "../o.txt", 100)).toEqual({ error: "path escapes root" })
    expect(readRegularFileIn(root, join(outside, "o.txt"), 100)).toEqual({
      error: "path escapes root",
    })
    symlinkSync(outside, join(root, "link"))
    expect(readRegularFileIn(root, "link/o.txt", 100)).toEqual({ error: "path escapes root" })
  })

  // Node fs has no API to make a FIFO, and spawning mkfifo is banned (protocol v2).
  // The reader opens with O_NONBLOCK and requires fstat isFile, so a FIFO gives
  // "not a file" without blocking. Skipped until a pure fs way exists.
  it.skip("a FIFO is refused without blocking (no node fs API to create one)", () => {})
})

describe("fix3: readFdCapped reads cap + 1, never trusts the fstat size", () => {
  it("a file that grows after open is too big, never silently truncated", () => {
    const p = join(root, "grow.txt")
    writeFileSync(p, "a".repeat(10))
    const fd = openSync(p, "r")
    try {
      // The file grows after the caller's fstat saw 10 bytes.
      appendFileSync(p, "b".repeat(100))
      expect(readFdCapped(fd, 50)).toEqual({ error: "too big" })
    } finally {
      closeSync(fd)
    }
  })

  it("at the cap exactly is ok", () => {
    const p = join(root, "exact.txt")
    writeFileSync(p, "c".repeat(50))
    const fd = openSync(p, "r")
    try {
      expect(readFdCapped(fd, 50)).toEqual({ ok: true, value: "c".repeat(50) })
    } finally {
      closeSync(fd)
    }
  })
})

describe("fix3: readUserFileCapped (no root confinement)", () => {
  it("reads an absolute regular file at any path", () => {
    const p = join(outside, "user.txt")
    writeFileSync(p, "hello", { mode: 0o644 })
    const r = readUserFileCapped(p, 100)
    expect("ok" in r && r.value?.text).toBe("hello")
    expect("ok" in r && r.value?.mode).toBe(0o644)
  })

  it("refuses a final symlink, a dir, a relative path, and over the cap", () => {
    const p = join(outside, "u2.txt")
    writeFileSync(p, "x".repeat(20))
    symlinkSync(p, join(outside, "u2-link.txt"))
    expect(readUserFileCapped(join(outside, "u2-link.txt"), 100)).toEqual({
      error: "target is a symlink",
    })
    expect(readUserFileCapped(outside, 100)).toEqual({ error: "not a file" })
    expect(readUserFileCapped("u2.txt", 100)).toEqual({ error: "bad path" })
    expect(readUserFileCapped(`${p}\0`, 100)).toEqual({ error: "bad path" })
    expect(readUserFileCapped(p, 19)).toEqual({ error: "too big" })
    expect(readUserFileCapped(p, 20)).toEqual({
      ok: true,
      value: expect.objectContaining({ text: "x".repeat(20) }),
    })
    expect(readUserFileCapped(join(outside, "none"), 100)).toEqual({ error: "missing" })
  })

  it("closes the fd on every path (no fd leak over many calls)", () => {
    const p = join(outside, "u3.txt")
    writeFileSync(p, "y".repeat(30))
    mkdirSync(join(outside, "u3d"))
    const before = openFdCount()
    for (let i = 0; i < 300; i++) {
      readUserFileCapped(p, 100)
      readUserFileCapped(p, 5)
      readUserFileCapped(join(outside, "u3d"), 100)
      readRegularFileIn(outside, "u3.txt", 5)
      readRegularFileIn(outside, "u3d", 100)
    }
    if (before >= 0) expect(openFdCount() - before).toBeLessThan(5)
  })
})

/** Open fd count from /dev/fd, or -1 when it cannot be listed. */
function openFdCount(): number {
  try {
    return readdirSync("/dev/fd").length
  } catch {
    return -1
  }
}

describe("fix4 (N5): writeFileIn never chmods by path", () => {
  it("fs.ts imports no chmodSync and uses fchmodSync", () => {
    const text = readFileSync(join(import.meta.dir, "fs.ts"), "utf8")
    expect(/\bchmodSync\b/.test(text.replace(/fchmodSync/g, ""))).toBe(false)
    expect(text.includes("fchmodSync")).toBe(true)
  })

  it("a new file gets the exact requested mode, no temp file left", () => {
    expect(writeFileIn(root, "m.txt", "x", { mode: 0o640 })).toEqual({ ok: true })
    expect(statSync(join(root, "m.txt")).mode & 0o777).toBe(0o640)
    expect(readdirSync(root)).toEqual(["m.txt"])
  })
})

describe("fix4 (N7): no O_NOFOLLOW gives an lstat fallback", () => {
  it("with nofollow undefined, a final symlink is still refused", () => {
    writeFileSync(join(outside, "o.txt"), "ooo")
    symlinkSync(join(outside, "o.txt"), join(root, "s.txt"))
    const r = FS.openNoFollow(join(root, "s.txt"), FS.READ_FLAGS, 0o600, undefined)
    expect(r).toEqual({ error: "target is a symlink" })
  })

  it("with nofollow undefined, a regular file opens", () => {
    writeFileSync(join(root, "r.txt"), "abc")
    const r = FS.openNoFollow(join(root, "r.txt"), FS.READ_FLAGS, 0o600, undefined)
    expect("fd" in r).toBe(true)
    if ("fd" in r) closeSync(r.fd)
  })

  it("with the real constant, a final symlink is refused too", () => {
    writeFileSync(join(outside, "o.txt"), "ooo")
    symlinkSync(join(outside, "o.txt"), join(root, "s.txt"))
    expect(FS.openNoFollow(join(root, "s.txt"), FS.READ_FLAGS, 0o600)).toEqual({
      error: "target is a symlink",
    })
  })
})

describe("fix4: appendFileIn (B9 audit log)", () => {
  it("100 appends: every line reads back intact, mode 0600", () => {
    const rows: string[] = []
    for (let i = 0; i < 100; i++) {
      const row = `${JSON.stringify({ i, k: "row".repeat(i % 7) })}\n`
      rows.push(row)
      expect(appendFileIn(root, "audit/log.jsonl", row)).toEqual({ ok: true })
    }
    const text = readText(root, "audit/log.jsonl")
    expect(text).toBe(rows.join(""))
    const lines = text.split("\n").filter((l) => l !== "")
    expect(lines.length).toBe(100)
    lines.forEach((l, i) => expect(JSON.parse(l).i).toBe(i))
    expect(statSync(join(root, "audit", "log.jsonl")).mode & 0o777).toBe(0o600)
  })

  it("an existing file keeps its content and gets the new row", () => {
    writeFileSync(join(root, "a.log"), "one\n", { mode: 0o600 })
    expect(appendFileIn(root, "a.log", "two\n")).toEqual({ ok: true })
    expect(readText(root, "a.log")).toBe("one\ntwo\n")
  })

  it("refuses a symlink target, and the target is unchanged", () => {
    writeFileSync(join(outside, "t.log"), "keep\n")
    symlinkSync(join(outside, "t.log"), join(root, "l.log"))
    const r = appendFileIn(root, "l.log", "x\n")
    expect("error" in r).toBe(true)
    expect(readFileSync(join(outside, "t.log"), "utf8")).toBe("keep\n")
  })

  it("refuses a dir, an escape and a bad root", () => {
    mkdirSync(join(root, "d"))
    expect("error" in appendFileIn(root, "d", "x")).toBe(true)
    expect(appendFileIn(root, "../e.log", "x")).toEqual({ error: "path escapes root" })
    expect(appendFileIn(join(root, "none"), "e.log", "x")).toEqual({ error: "bad root" })
    expect(readdirSync(outside)).toEqual([])
  })

  it("never throws on bad data", () => {
    expect("error" in appendFileIn(root, "z.log", null as unknown as string)).toBe(true)
  })
})

describe("fix4: renameFileIn", () => {
  it("renames inside the root", () => {
    writeFileSync(join(root, "a.log"), "aaa")
    expect(renameFileIn(root, "a.log", "old/a.1.log")).toEqual({ ok: true })
    expect(readText(root, "old/a.1.log")).toBe("aaa")
    expect(readdirSync(root).sort()).toEqual(["old"])
  })

  it("refuses an escape at either end", () => {
    writeFileSync(join(root, "a.log"), "aaa")
    writeFileSync(join(outside, "o.log"), "ooo")
    expect(renameFileIn(root, "a.log", "../esc.log")).toEqual({ error: "path escapes root" })
    expect(renameFileIn(root, "a.log", join(outside, "x.log"))).toEqual({
      error: "path escapes root",
    })
    expect(renameFileIn(root, join(outside, "o.log"), "in.log")).toEqual({
      error: "path escapes root",
    })
    symlinkSync(outside, join(root, "link"))
    expect(renameFileIn(root, "a.log", "link/x.log")).toEqual({ error: "path escapes root" })
    expect(readdirSync(outside).sort()).toEqual(["o.log"])
    expect(readText(root, "a.log")).toBe("aaa")
  })

  it("refuses a symlink or dir source and a symlink or dir target", () => {
    writeFileSync(join(outside, "o.log"), "ooo")
    symlinkSync(join(outside, "o.log"), join(root, "s.log"))
    expect(renameFileIn(root, "s.log", "t.log")).toEqual({ error: "target is a symlink" })
    mkdirSync(join(root, "d"))
    expect(renameFileIn(root, "d", "t.log")).toEqual({ error: "not a file" })
    writeFileSync(join(root, "a.log"), "aaa")
    expect(renameFileIn(root, "a.log", "s.log")).toEqual({ error: "target is a symlink" })
    expect(renameFileIn(root, "a.log", "d")).toEqual({ error: "not a file" })
    expect(renameFileIn(root, "none.log", "t.log")).toEqual({ error: "missing" })
    expect(readFileSync(join(outside, "o.log"), "utf8")).toBe("ooo")
  })
})

describe("fix4: removeFileIn", () => {
  it("removes a regular file", () => {
    writeFileSync(join(root, "a.log"), "aaa")
    expect(removeFileIn(root, "a.log")).toEqual({ ok: true })
    expect(readdirSync(root)).toEqual([])
    expect(removeFileIn(root, "a.log")).toEqual({ error: "missing" })
  })

  it("refuses a symlink: the link and its target survive", () => {
    writeFileSync(join(outside, "o.log"), "ooo")
    symlinkSync(join(outside, "o.log"), join(root, "s.log"))
    expect(removeFileIn(root, "s.log")).toEqual({ error: "target is a symlink" })
    expect(readFileSync(join(outside, "o.log"), "utf8")).toBe("ooo")
    expect(readdirSync(root)).toEqual(["s.log"])
  })

  it("refuses a dir and an escape", () => {
    mkdirSync(join(root, "d"))
    expect(removeFileIn(root, "d")).toEqual({ error: "not a file" })
    expect(statSync(join(root, "d")).isDirectory()).toBe(true)
    writeFileSync(join(outside, "o.log"), "ooo")
    expect(removeFileIn(root, "../o.log")).toEqual({ error: "path escapes root" })
    expect(removeFileIn(root, join(outside, "o.log"))).toEqual({ error: "path escapes root" })
    expect(readdirSync(outside)).toEqual(["o.log"])
  })
})

describe("fix3: fs.ts is the only node:fs importer in src/state", () => {
  it("no other non-test module in src/state imports node:fs", () => {
    const dir = import.meta.dir
    const offenders: string[] = []
    let seen = 0
    for (const f of new Bun.Glob("*.ts").scanSync(dir)) {
      if (f.endsWith(".test.ts")) continue
      seen++
      const text = readFileSync(join(dir, f), "utf8")
      const hit = /from\s+["'](node:)?fs(\/promises)?["']|require\(\s*["'](node:)?fs/.test(text)
      if (hit && f !== "fs.ts") offenders.push(f)
    }
    expect(seen).toBeGreaterThan(5)
    expect(offenders).toEqual([])
  })
})
