import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { pluginSideband } from "../../tests/support/sideband.ts"

import {
  expandPasteRefs,
  isPasteId,
  isSafeSid,
  PASTE_CUT_MARKER,
  PASTE_MAX_CHARS,
  PASTE_MISSING_MARKER,
  type PasteSource,
  pastePath,
  readPasteFile,
} from "./paste.ts"

/** The real codec (`tests/support/sideband.ts`). */
const sb = await pluginSideband()

const DIR = resolve("/sessions-root")
const SID = "ba0ad20f-0000-4000-8000-666ff6ccaa5b"
const URL =
  "https://linear.app/arcanums/issue/DEV-244/user-can-make-a-shared-project-view-only-for-a-team"

/** A paste ref of the real codec. */
function ref(id: string, body?: string): string {
  return sb.render("paste", {
    attrs: { id, bytes: 93, lines: 1 },
    ...(body === undefined ? {} : { body }),
  })
}

/** A source with a fake file map. It records each read path. */
function source(files: Record<string, string>, sid = SID): PasteSource & { reads: string[] } {
  const reads: string[] = []
  return {
    sessionsDir: DIR,
    sid,
    reads,
    readFile: (path) => {
      reads.push(path)
      return files[path] ?? null
    },
  }
}

const FILE = join(DIR, `${SID}.files`, "paste", "m23a7.txt")

describe("expandPasteRefs", () => {
  test("a ref becomes the text of its file", () => {
    const src = source({ [FILE]: URL })
    const out = expandPasteRefs(`status of ${ref("m23a7")} ?`, sb, src)
    expect(out).toBe(`status of ${URL} ?`)
    expect(src.reads).toEqual([FILE])
  })

  test("a missing file gives the marker", () => {
    const src = source({})
    expect(expandPasteRefs(`see ${ref("m23a7")}`, sb, src)).toBe(`see ${PASTE_MISSING_MARKER}`)
    expect(src.reads).toEqual([FILE])
  })

  test("a reader that throws gives the marker", () => {
    const src: PasteSource = {
      sessionsDir: DIR,
      sid: SID,
      readFile: () => {
        throw new Error("EACCES")
      },
    }
    expect(expandPasteRefs(ref("m23a7"), sb, src)).toBe(PASTE_MISSING_MARKER)
  })

  test("a bad id does not read a file", () => {
    for (const id of ["../x", "M23A7", "m23a", "m23a77", "a/b/c", "..", "m23a7.txt"]) {
      const src = source({ [FILE]: URL })
      expect(expandPasteRefs(`x ${ref(id)} y`, sb, src)).toBe(`x ${PASTE_MISSING_MARKER} y`)
      expect(src.reads).toEqual([])
    }
  })

  test("a bad sid does not read a file", () => {
    for (const sid of ["", "../etc", "a/b", "a\\b", "..", "x\0y"]) {
      const src = source({ [FILE]: URL }, sid)
      expect(expandPasteRefs(ref("m23a7"), sb, src)).toBe(PASTE_MISSING_MARKER)
      expect(src.reads).toEqual([])
    }
  })

  test("no source gives the marker and reads nothing", () => {
    expect(expandPasteRefs(`a ${ref("m23a7")} b`, sb, undefined)).toBe(
      `a ${PASTE_MISSING_MARKER} b`,
    )
  })

  test("a ref with a body keeps its body and reads no file", () => {
    const src = source({ [FILE]: "file text" })
    expect(expandPasteRefs(`a ${ref("m23a7", "inline body")} b`, sb, src)).toBe("a inline body b")
    expect(src.reads).toEqual([])
  })

  test("a long paste keeps the head, then the cut marker", () => {
    const long = "漢".repeat(PASTE_MAX_CHARS + 50)
    const out = expandPasteRefs(ref("m23a7"), sb, source({ [FILE]: long }))
    expect(out).toBe(`${"漢".repeat(PASTE_MAX_CHARS)}\n${PASTE_CUT_MARKER}`)
  })

  test("a paste of exactly the cap does not change", () => {
    const text = "a".repeat(PASTE_MAX_CHARS)
    expect(expandPasteRefs(ref("m23a7"), sb, source({ [FILE]: text }))).toBe(text)
  })

  test("CRLF in the file becomes LF", () => {
    expect(expandPasteRefs(ref("m23a7"), sb, source({ [FILE]: "a\r\nb\rc" }))).toBe("a\nb\nc")
  })

  test("text with no ref does not change", () => {
    expect(expandPasteRefs("plain text", sb, source({}))).toBe("plain text")
  })
})

describe("paste path checks", () => {
  test("isPasteId: 5 chars of [0-9a-z]", () => {
    expect(isPasteId("m23a7")).toBe(true)
    expect(isPasteId("00000")).toBe(true)
    for (const bad of ["", "m23a", "m23a77", "M23A7", "../aa", 5, undefined]) {
      expect(isPasteId(bad)).toBe(false)
    }
  })

  test("isSafeSid: no slash, no backslash, no dot-dot, no NUL", () => {
    expect(isSafeSid(SID)).toBe(true)
    for (const bad of ["", " ", "a/b", "a\\b", "..", "a..b", "x\0y", 3]) {
      expect(isSafeSid(bad)).toBe(false)
    }
  })

  test("pastePath stays in the paste dir of the sid", () => {
    expect(pastePath(DIR, SID, "m23a7")).toBe(FILE)
    expect(pastePath(DIR, "../x", "m23a7")).toBeUndefined()
    expect(pastePath(DIR, SID, "../../x")).toBeUndefined()
    expect(pastePath("", SID, "m23a7")).toBeUndefined()
    expect(pastePath("relative/dir", SID, "m23a7")).toBeUndefined()
  })
})

describe("readPasteFile: only a regular file (m1)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-title-paste-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("a regular file gives its text", () => {
    const path = join(dir, "m23a7.txt")
    writeFileSync(path, "pasted text")
    expect(readPasteFile(path)).toBe("pasted text")
  })

  test.skipIf(process.platform === "win32")("a symlink gives null (O_NOFOLLOW)", () => {
    const secret = join(dir, "secret.txt")
    writeFileSync(secret, "private data")
    const link = join(dir, "m23a7.txt")
    symlinkSync(secret, link)
    expect(readPasteFile(link)).toBeNull()
  })

  test("a directory gives null", () => {
    const sub = join(dir, "m23a7.txt")
    mkdirSync(sub)
    expect(readPasteFile(sub)).toBeNull()
  })

  test.skipIf(process.platform === "win32" || !Bun.which("mkfifo"))(
    "a FIFO gives null and does not block",
    () => {
      const fifo = join(dir, "m23a7.txt")
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0)
      expect(readPasteFile(fifo)).toBeNull()
    },
  )
})
