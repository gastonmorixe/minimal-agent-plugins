import { createHmac } from "node:crypto"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { makeFixtureDir, removeFixtureDir } from "../test-support.ts"

import { readRegularFileIn } from "./fs.ts"
import {
  copySessionKey,
  memorySessionKey,
  openSessionKey,
  SIDECAR_DIR_REFUSED_REASON,
  SIDECAR_NOT_REGULAR_REASON,
  sessionKeyFromBytes,
  sidecarPathFor,
} from "./session-key.ts"

/** createHmac("sha256", bytes 0x00..0x1f).update("known-answer-value-1"), first 8 hex. */
const KAT_TAG = "6573202c"

const root = makeFixtureDir("b6-key-")
const outside = makeFixtureDir("b6-key-out-")
afterAll(() => {
  removeFixtureDir(root)
  removeFixtureDir(outside)
})

let n = 0
function sessionFile(): string {
  n++
  return join(root, `sess-${n}.jsonl`)
}

describe("sidecarPathFor", () => {
  it("puts <sid>.security-key beside the jsonl", () => {
    expect(sidecarPathFor("/a/b/abc.jsonl")).toBe("/a/b/abc.security-key")
    expect(sidecarPathFor("/a/b/abc")).toBe("/a/b/abc.security-key")
  })
})

describe("session key", () => {
  it("tag is 8 lowercase hex and deterministic", () => {
    const k = openSessionKey(sessionFile())
    const t = k.tag("some-value-123")
    expect(t).toMatch(/^[0-9a-f]{8}$/)
    expect(k.tag("some-value-123")).toBe(t)
    expect(k.tag("some-value-124")).not.toBe(t)
  })

  it("creates the sidecar with mode 0600", () => {
    const f = sessionFile()
    const k = openSessionKey(f)
    expect(k.status).toBe("created")
    expect(k.error).toBeNull()
    const st = statSync(sidecarPathFor(f))
    expect(st.mode & 0o777).toBe(0o600)
    expect(readFileSync(sidecarPathFor(f), "utf8")).toMatch(/^[0-9a-f]{64}\n$/)
  })

  it("resume (new instance, same sidecar) keeps tags stable", () => {
    const f = sessionFile()
    const a = openSessionKey(f)
    const b = openSessionKey(f)
    expect(b.status).toBe("loaded")
    expect(b.tag("resume-value-xyz")).toBe(a.tag("resume-value-xyz"))
  })

  it("two sessions get different keys", () => {
    expect(openSessionKey(sessionFile()).tag("same-value-1")).not.toBe(
      openSessionKey(sessionFile()).tag("same-value-1"),
    )
  })

  it("a corrupt sidecar gives a new key and records it", () => {
    const f = sessionFile()
    writeFileSync(sidecarPathFor(f), "not hex at all", { mode: 0o600 })
    const a = openSessionKey(f)
    expect(a.status).toBe("replaced")
    const b = openSessionKey(f)
    expect(b.status).toBe("loaded")
    expect(b.tag("v-corrupt-1")).toBe(a.tag("v-corrupt-1"))
    expect(statSync(sidecarPathFor(f)).mode & 0o777).toBe(0o600)
  })

  it("an empty sidecar counts as corrupt", () => {
    const f = sessionFile()
    writeFileSync(sidecarPathFor(f), "", { mode: 0o600 })
    expect(openSessionKey(f).status).toBe("replaced")
  })

  it("a loose sidecar mode (0644) is corrupt: replaced, never chmodded", () => {
    const f = sessionFile()
    const a = openSessionKey(f)
    chmodSync(sidecarPathFor(f), 0o644)
    const b = openSessionKey(f)
    expect(b.status).toBe("replaced")
    expect(b.error).toBe("sidecar corrupt, replaced")
    expect(b.tag("loose-mode-1")).not.toBe(a.tag("loose-mode-1"))
    expect(statSync(sidecarPathFor(f)).mode & 0o777).toBe(0o600)
  })

  it("other non-0600 modes (0400, 0700) are corrupt too", () => {
    for (const mode of [0o400, 0o700]) {
      const f = sessionFile()
      openSessionKey(f)
      chmodSync(sidecarPathFor(f), mode)
      expect(openSessionKey(f).status).toBe("replaced")
    }
  })

  it("a short file (63 hex) is corrupt", () => {
    const f = sessionFile()
    writeFileSync(sidecarPathFor(f), `${"a".repeat(63)}\n`, { mode: 0o600 })
    expect(openSessionKey(f).status).toBe("replaced")
  })

  it("non-hex or uppercase content of 64 chars is corrupt", () => {
    for (const body of [`${"g".repeat(64)}\n`, `${"A".repeat(64)}\n`, `${"a".repeat(64)}x`]) {
      const f = sessionFile()
      writeFileSync(sidecarPathFor(f), body, { mode: 0o600 })
      expect(openSessionKey(f).status).toBe("replaced")
    }
  })

  it("a sidecar owned by another uid is corrupt (uid injected)", () => {
    const f = sessionFile()
    openSessionKey(f)
    const me = typeof process.getuid === "function" ? process.getuid() : 0
    expect(openSessionKey(f, { uid: me + 1 }).status).toBe("replaced")
  })

  it("a directory at the sidecar path is never loaded", () => {
    const f = sessionFile()
    mkdirSync(sidecarPathFor(f))
    const k = openSessionKey(f)
    expect(k.status).not.toBe("loaded")
    expect(k.tag("dir-case-1")).toMatch(/^[0-9a-f]{8}$/)
  })

  it("HMAC known answer: fixed key bytes and value give the createHmac tag", () => {
    const keyHex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    const value = "known-answer-value-1"
    const want = createHmac("sha256", Buffer.from(keyHex, "hex"))
      .update(value, "utf8")
      .digest("hex")
      .slice(0, 8)
    // Pinned literal: if node:crypto ever changed, this catches it too.
    expect(want).toBe(KAT_TAG)
    const f = sessionFile()
    writeFileSync(sidecarPathFor(f), `${keyHex}\n`, { mode: 0o600 })
    const k = openSessionKey(f)
    expect(k.status).toBe("loaded")
    expect(k.tag(value)).toBe(want)
    expect(sessionKeyFromBytes(Buffer.from(keyHex, "hex")).tag(value)).toBe(want)
  })

  it("HMAC failure gives null, never a shared fallback tag", () => {
    const k = sessionKeyFromBytes(Buffer.alloc(32, 1), () => {
      throw new Error("hmac broke")
    })
    expect(k.tag("any-value-1")).toBeNull()
    expect(k.tag("any-value-2")).toBeNull()
  })

  it("pid is injectable for the temp file name", () => {
    const f = sessionFile()
    const k = openSessionKey(f, { pid: 4242 })
    expect(k.status).toBe("created")
    expect([...new Bun.Glob("*.tmp*").scanSync(root)]).toEqual([])
  })

  it("an unwritable dir gives a memory key and an error, never a throw", () => {
    const k = openSessionKey(join(root, "no-such-dir", "x.jsonl"))
    expect(k.status).toBe("memory")
    expect(k.error).not.toBeNull()
    expect(k.tag("still-works-1")).toMatch(/^[0-9a-f]{8}$/)
  })

  it("null session file gives a memory key", () => {
    const k = openSessionKey(null)
    expect(k.status).toBe("memory")
    expect(k.path).toBeNull()
    expect(memorySessionKey().tag("abcdefgh")).toMatch(/^[0-9a-f]{8}$/)
  })

  it("leaves no temp files behind", () => {
    const f = sessionFile()
    openSessionKey(f)
    const left = new Bun.Glob("*.tmp*").scanSync(root)
    expect([...left]).toEqual([])
  })

  it("sidecar round trip through fs.ts (readRegularFileIn sees the written key)", () => {
    const f = sessionFile()
    const a = openSessionKey(f)
    const got = readRegularFileIn(root, basename(sidecarPathFor(f)), 4096)
    expect("ok" in got && /^[0-9a-f]{64}\n$/.test(got.value?.text as string)).toBe(true)
    expect(openSessionKey(f).tag("round-trip-1")).toBe(a.tag("round-trip-1"))
  })

  it("a symlinked sidecar is never followed (read, chmod or write)", () => {
    const f = sessionFile()
    const target = join(outside, "planted.key")
    const planted = `${"ab".repeat(32)}\n`
    writeFileSync(target, planted, { mode: 0o644 })
    symlinkSync(target, sidecarPathFor(f))
    const k = openSessionKey(f)
    expect(k.status).not.toBe("loaded")
    expect(k.status).toBe("memory")
    expect(readFileSync(target, "utf8")).toBe(planted)
    expect(statSync(target).mode & 0o777).toBe(0o644)
  })

  it("fix3: a non-regular sidecar (dir, symlink) is never replaced: memory key, fixed reason", () => {
    const fd = sessionFile()
    mkdirSync(sidecarPathFor(fd))
    const kd = openSessionKey(fd)
    expect(kd.status).toBe("memory")
    expect(kd.error).toBe(SIDECAR_NOT_REGULAR_REASON)
    expect(statSync(sidecarPathFor(fd)).isDirectory()).toBe(true)

    const fl = sessionFile()
    const target = join(outside, "planted-2.key")
    writeFileSync(target, "not a key", { mode: 0o600 })
    symlinkSync(target, sidecarPathFor(fl))
    const kl = openSessionKey(fl)
    expect(kl.status).toBe("memory")
    expect(kl.error).toBe(SIDECAR_NOT_REGULAR_REASON)
    expect(lstatSync(sidecarPathFor(fl)).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, "utf8")).toBe("not a key")
    expect(SIDECAR_NOT_REGULAR_REASON).not.toContain(root)
  })

  it("fix4 (N3): a symlinked session dir gives a memory key with a fixed reason", () => {
    const realDir = join(root, "real-sess-dir")
    mkdirSync(realDir)
    const linkDir = join(root, "link-sess-dir")
    symlinkSync(realDir, linkDir)
    const k = openSessionKey(join(linkDir, "s.jsonl"))
    expect(k.status).toBe("memory")
    expect(k.error).toBe(SIDECAR_DIR_REFUSED_REASON)
    expect(k.error).not.toContain(root)
    expect(readdirSync(realDir)).toEqual([])
  })

  it("fix4: lost EEXIST create race: the winner's key is loaded", () => {
    const f = sessionFile()
    const winner = Buffer.alloc(32, 7)
    const k = openSessionKey(f, {
      beforeCreate: () => {
        writeFileSync(sidecarPathFor(f), `${winner.toString("hex")}\n`, { mode: 0o600 })
      },
    })
    expect(k.status).toBe("loaded")
    expect(k.error).toBeNull()
    expect(k.tag("race-1")).toBe(sessionKeyFromBytes(winner).tag("race-1"))
  })

  it("fix4: lost EEXIST race to a corrupt file: memory key, the file is not replaced", () => {
    const f = sessionFile()
    const k = openSessionKey(f, {
      beforeCreate: () => {
        writeFileSync(sidecarPathFor(f), "junk", { mode: 0o600 })
      },
    })
    expect(k.status).toBe("memory")
    expect(k.error).toBe("sidecar write failed: EEXIST")
    expect(readFileSync(sidecarPathFor(f), "utf8")).toBe("junk")
  })

  it("fix3: copySessionKey never writes over a non-regular target", () => {
    const a = sessionFile()
    const b = sessionFile()
    openSessionKey(a)
    mkdirSync(sidecarPathFor(b))
    expect(copySessionKey(a, b)).toBe(false)
    expect(statSync(sidecarPathFor(b)).isDirectory()).toBe(true)
  })

  it("fork copies the key", () => {
    const a = sessionFile()
    const b = sessionFile()
    const ka = openSessionKey(a)
    expect(copySessionKey(a, b)).toBe(true)
    expect(existsSync(sidecarPathFor(b))).toBe(true)
    expect(statSync(sidecarPathFor(b)).mode & 0o777).toBe(0o600)
    expect(openSessionKey(b).tag("fork-value-1")).toBe(ka.tag("fork-value-1"))
    // Exclusive: an existing target is not overwritten.
    expect(copySessionKey(a, b)).toBe(false)
    // A missing source copies nothing.
    expect(copySessionKey(sessionFile(), sessionFile())).toBe(false)
  })
})
