// File IO for src/state. The ONLY module in src/state that imports node:fs (a test
// pins this). Writes go through writeFileIn, appendFileIn, renameFileIn and removeFileIn.
// Every read goes through one fd (readRegularFileIn, readUserFileCapped). The `...In`
// functions are contained: they refuse a path that leaves `root` (lexical `..`, absolute
// path, or a symlink in a parent), a final target that is a symlink, and a root that is
// not a real directory owned by the current user. A root that is itself a symlink is
// "bad root". Accepted race (N5): a parent dir swapped between the parent check and the
// final open or rename. The dirs are owned by the current uid, so only that uid can swap
// them. Sync only. Never throws. Never logs. Error texts are fixed strings: they never
// hold a path or file content.

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export type FsError =
  | "bad root"
  | "bad path"
  | "path escapes root"
  | "target is a symlink"
  | "not a file"
  | "missing"
  | "too big"
  | "exists"
  | "write failed"
  | "read failed"

export type FsResult<T> = { ok: true; value?: T } | { error: FsError }

export type WriteOptions = {
  /** File mode for a new file. Default 0600. */
  mode?: number
  /** Fail with "exists" when the target exists (temp file plus link). Default false. */
  exclusive?: boolean
  /** Pid for the temp file name (injected, D12). Default process.pid (fs.ts is the IO edge). */
  pid?: number
}

/** A regular file read through one fd: its text plus the fstat owner and permission bits. */
export type RegularFile = { text: string; uid: number; mode: number }

function codeOf(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code
  return typeof c === "string" ? c : ""
}

function inside(base: string, p: string): boolean {
  return p === base || p.startsWith(base.endsWith(sep) ? base : base + sep)
}

/** Root checks: a real directory (not a symlink), owned by the current user. */
function checkRoot(root: string): string | null {
  try {
    if (typeof root !== "string" || root === "" || root.includes("\0")) return null
    const st = lstatSync(root)
    if (!st.isDirectory()) return null
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null
    return realpathSync(root)
  } catch {
    return null
  }
}

type Resolved = { target: string; rootReal: string } | { error: FsError }

/**
 * Resolve relPath under root. The lexical check stops `..` and outside absolute paths.
 * The realpath check of the nearest existing parent stops a symlink escape.
 */
function resolveIn(root: string, relPath: string): Resolved {
  const rootReal = checkRoot(root)
  if (rootReal === null) return { error: "bad root" }
  if (typeof relPath !== "string" || relPath === "" || relPath.includes("\0")) {
    return { error: "bad path" }
  }
  let target: string
  if (isAbsolute(relPath)) {
    const abs = resolve(relPath)
    const rootAbs = resolve(root)
    if (inside(rootAbs, abs)) target = join(rootReal, relative(rootAbs, abs))
    else if (inside(rootReal, abs)) target = abs
    else return { error: "path escapes root" }
  } else {
    target = resolve(rootReal, relPath)
  }
  if (target === rootReal || !inside(rootReal, target)) return { error: "path escapes root" }
  const parentErr = checkParent(rootReal, dirname(target))
  if (parentErr !== null) return { error: parentErr }
  return { target, rootReal }
}

/** Realpath of the nearest existing ancestor of dir must be inside rootReal. */
function checkParent(rootReal: string, dir: string): FsError | null {
  let cur = dir
  for (;;) {
    try {
      const real = realpathSync(cur)
      return inside(rootReal, real) ? null : "path escapes root"
    } catch (e) {
      if (codeOf(e) !== "ENOENT") return "path escapes root"
      const up = dirname(cur)
      if (up === cur) return "path escapes root"
      cur = up
    }
  }
}

/** lstat of the final target: "none", "file", or an error. */
function targetKind(target: string): "none" | "file" | FsError {
  try {
    const st = lstatSync(target)
    if (st.isSymbolicLink()) return "target is a symlink"
    return st.isFile() ? "file" : "not a file"
  } catch (e) {
    return codeOf(e) === "ENOENT" ? "none" : "read failed"
  }
}

let tmpSeq = 0

/**
 * Write data to root/relPath. Atomic: a temp file in the same dir (flag "wx", the given
 * mode, default 0600), then rename (or link when `exclusive`). Creates missing parent
 * dirs (mode 0700) inside root. Never throws.
 */
export function writeFileIn(
  root: string,
  relPath: string,
  data: string | Uint8Array,
  opts: WriteOptions = {},
): FsResult<never> {
  try {
    const r = resolveIn(root, relPath)
    if ("error" in r) return r
    const kind = targetKind(r.target)
    if (kind !== "none" && kind !== "file") return { error: kind }
    if (kind === "file" && opts.exclusive === true) return { error: "exists" }
    const dir = dirname(r.target)
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch {
      return { error: "write failed" }
    }
    // Re-check after mkdir: a parent may have been swapped in between.
    const again = checkParent(r.rootReal, dir)
    if (again !== null) return { error: again }
    const mode = typeof opts.mode === "number" ? opts.mode & 0o777 : 0o600
    tmpSeq++
    const pid = typeof opts.pid === "number" && Number.isInteger(opts.pid) ? opts.pid : process.pid
    const tmp = join(dir, `.${basename(r.target)}.tmp${pid}.${tmpSeq}`)
    try {
      // "wx" is O_CREAT|O_EXCL: it never opens an existing path or follows a link. The
      // mode is set on the fd (never chmod by path, N5), then the data goes to the fd.
      const fd = openSync(tmp, "wx", mode)
      try {
        fchmodSync(fd, mode)
        writeFileSync(fd, data)
      } finally {
        closeSync(fd)
      }
      if (opts.exclusive === true) {
        linkSync(tmp, r.target)
        unlinkSync(tmp)
      } else {
        renameSync(tmp, r.target)
      }
      return { ok: true }
    } catch (e) {
      try {
        unlinkSync(tmp)
      } catch {
        // temp file may not exist
      }
      return { error: codeOf(e) === "EEXIST" ? "exists" : "write failed" }
    }
  } catch {
    return { error: "write failed" }
  }
}

/** Largest cap the single-fd read accepts (one Buffer of cap + 1 bytes). */
const MAX_READ_CAP = 256 * 1024 * 1024

function capOk(cap: number): boolean {
  return Number.isInteger(cap) && cap >= 0 && cap <= MAX_READ_CAP
}

/**
 * Read an open fd as UTF-8. Allocates cap + 1 bytes and reads until EOF or cap + 1
 * bytes, so a file that grew after fstat is "too big", never silently truncated. Never
 * trusts the fstat size. Does not close the fd (the caller owns it). Never throws.
 */
export function readFdCapped(fd: number, cap: number): FsResult<string> {
  try {
    if (!capOk(cap)) return { error: "too big" }
    const buf = Buffer.alloc(cap + 1)
    let got = 0
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, null)
      if (n <= 0) break
      got += n
    }
    if (got > cap) return { error: "too big" }
    return { ok: true, value: buf.subarray(0, got).toString("utf8") }
  } catch {
    return { error: "read failed" }
  }
}

/** Read flags: O_RDONLY | O_NONBLOCK (a FIFO never blocks). openNoFollow adds no-follow. */
export const READ_FLAGS: number = constants.O_RDONLY | constants.O_NONBLOCK

/**
 * Open a final path without following a symlink. `nofollow` defaults to
 * constants.O_NOFOLLOW. Where it is undefined (N7, for example Windows), lstat first
 * and refuse a symlink, then open (a small lstat-to-open race stays there, and the
 * caller's fstat still requires a regular file). Errors: "missing", "target is a
 * symlink", "exists" (O_EXCL), else "write failed". The caller owns and closes the fd.
 * Exported for tests. Never throws.
 */
export function openNoFollow(
  path: string,
  flags: number,
  mode: number,
  nofollow: number | undefined = constants.O_NOFOLLOW,
): { fd: number } | { error: FsError } {
  try {
    if (nofollow === undefined) {
      try {
        if (lstatSync(path).isSymbolicLink()) return { error: "target is a symlink" }
      } catch (e) {
        const c = codeOf(e)
        if (c !== "ENOENT") return { error: c === "ENOTDIR" ? "missing" : "write failed" }
        // ENOENT is fine when the flags create the file. Else open reports "missing".
      }
    }
    return { fd: openSync(path, flags | (nofollow ?? 0), mode) }
  } catch (e) {
    const c = codeOf(e)
    if (c === "ENOENT" || c === "ENOTDIR") return { error: "missing" }
    if (c === "ELOOP" || c === "EMLINK") return { error: "target is a symlink" }
    if (c === "EEXIST") return { error: "exists" }
    return { error: "write failed" }
  }
}

/**
 * The one safe read: open with O_NOFOLLOW (a final symlink fails) and O_NONBLOCK (a
 * FIFO never blocks), fstat the fd, require a regular file, read at most cap + 1 bytes.
 * The fd is closed on every path (try/finally). Never throws.
 */
function readOpenSafe(target: string, cap: number): FsResult<RegularFile> {
  let fd = -1
  try {
    if (!capOk(cap)) return { error: "too big" }
    const o = openNoFollow(target, READ_FLAGS, 0)
    if ("error" in o) return { error: o.error === "write failed" ? "read failed" : o.error }
    fd = o.fd
    const st = fstatSync(fd)
    if (!st.isFile()) return { error: "not a file" }
    if (st.size > cap) return { error: "too big" }
    const r = readFdCapped(fd, cap)
    if ("error" in r) return r
    return {
      ok: true,
      value: { text: r.value ?? "", uid: st.uid, mode: st.mode & 0o777 },
    }
  } catch {
    return { error: "read failed" }
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd)
      } catch {
        // already closed
      }
    }
  }
}

/**
 * Read root/relPath through one fd (readOpenSafe). Returns the text with the fstat uid
 * and mode & 0o777. Same path refusals as writeFileIn. Never throws.
 */
export function readRegularFileIn(
  root: string,
  relPath: string,
  cap: number,
): FsResult<RegularFile> {
  try {
    const r = resolveIn(root, relPath)
    if ("error" in r) return r
    return readOpenSafe(r.target, cap)
  } catch {
    return { error: "read failed" }
  }
}

/** The last bytes of a regular file. */
export type FileTail = {
  /** UTF-8 text of the tail. A partial first character becomes U+FFFD. */
  text: string
  /** True when the file was longer than the tail: the first line may be partial. */
  truncatedHead: boolean
  /** File size in bytes (fstat at open). */
  size: number
}

/**
 * Read the LAST min(cap, size) bytes of root/relPath through one fd. Same refusals as
 * readRegularFileIn (root confinement, a final symlink, a non-regular file, a FIFO never
 * blocks). Uses positioned reads from size - cap, so memory stays at cap bytes for a file
 * of any size. Bytes appended after the fstat are not read. The fd is closed on every
 * path. Never throws.
 */
export function readTailFileIn(root: string, relPath: string, cap: number): FsResult<FileTail> {
  let fd = -1
  try {
    if (!Number.isInteger(cap) || cap < 0 || cap > MAX_READ_CAP) return { error: "too big" }
    const r = resolveIn(root, relPath)
    if ("error" in r) return r
    const o = openNoFollow(r.target, READ_FLAGS, 0)
    if ("error" in o) return { error: o.error === "write failed" ? "read failed" : o.error }
    fd = o.fd
    const st = fstatSync(fd)
    if (!st.isFile()) return { error: "not a file" }
    const size = st.size
    const want = Math.min(cap, size)
    const start = size - want
    const buf = Buffer.alloc(want)
    let got = 0
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, start + got)
      if (n <= 0) break
      got += n
    }
    return {
      ok: true,
      value: { text: buf.subarray(0, got).toString("utf8"), truncatedHead: start > 0, size },
    }
  } catch {
    return { error: "read failed" }
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd)
      } catch {
        // already closed
      }
    }
  }
}

/**
 * Read a user file at an absolute path through one fd (readOpenSafe), WITHOUT root
 * confinement. Why: the harness credential file and the vault target files (Edit and
 * Write targets) are user files at arbitrary paths, not under the session root, so there
 * is no root to confine to. The read is still safe: a final symlink fails (O_NOFOLLOW),
 * a FIFO never blocks (O_NONBLOCK), a non-regular file fails (fstat), and at most
 * cap + 1 bytes are read. Parent dir symlinks are followed (the caller passes a real
 * path). A relative path or a NUL byte is "bad path". Never throws.
 */
export function readUserFileCapped(absPath: string, cap: number): FsResult<RegularFile> {
  try {
    if (typeof absPath !== "string" || absPath === "" || absPath.includes("\0")) {
      return { error: "bad path" }
    }
    if (!isAbsolute(absPath)) return { error: "bad path" }
    return readOpenSafe(absPath, cap)
  } catch {
    return { error: "read failed" }
  }
}

/**
 * Change stamp of a user file at an absolute path (lstat, no follow): "mtime:size:ino",
 * or null when it cannot be read. Holds no file content. Never throws.
 */
export function userFileStamp(absPath: string): string | null {
  try {
    if (typeof absPath !== "string" || absPath.includes("\0") || !isAbsolute(absPath)) return null
    const st = lstatSync(absPath)
    return `${st.mtimeMs}:${st.size}:${st.ino}`
  } catch {
    return null
  }
}

/** Kind of the final path entry, no follow: "none", "file", or "other" (dir, symlink, FIFO). */
export function entryKindIn(root: string, relPath: string): "none" | "file" | "other" | FsError {
  try {
    const r = resolveIn(root, relPath)
    if ("error" in r) return r.error
    const k = targetKind(r.target)
    if (k === "none" || k === "file") return k
    if (k === "target is a symlink" || k === "not a file") return "other"
    return k
  } catch {
    return "read failed"
  }
}

/**
 * Append `data` to root/relPath (B9 audit log). Creates missing parent dirs (0700) and
 * the file (0600) inside root. Open: O_WRONLY|O_APPEND|O_CREAT plus no-follow (lstat
 * fallback where O_NOFOLLOW is undefined) and O_NONBLOCK. fstat must show a regular file.
 * A file this call created gets fchmod 0600. The data goes in exactly ONE writeSync, so
 * a row is never split by this process. A short write (bytesWritten !== byte length) is
 * "write failed". The fd is closed in finally. Same root refusals as writeFileIn. A
 * symlink target is refused. Never throws.
 */
export function appendFileIn(
  root: string,
  relPath: string,
  data: string | Uint8Array,
): FsResult<never> {
  let fd = -1
  try {
    if (typeof data !== "string" && !(data instanceof Uint8Array)) return { error: "bad path" }
    const r = resolveIn(root, relPath)
    if ("error" in r) return r
    const kind = targetKind(r.target)
    if (kind !== "none" && kind !== "file") return { error: kind }
    const dir = dirname(r.target)
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch {
      return { error: "write failed" }
    }
    const again = checkParent(r.rootReal, dir)
    if (again !== null) return { error: again }
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK
    const o = openNoFollow(r.target, flags, 0o600)
    if ("error" in o) return { error: o.error === "missing" ? "write failed" : o.error }
    fd = o.fd
    const st = fstatSync(fd)
    if (!st.isFile()) return { error: "not a file" }
    // Created now: empty and new. Set the mode on the fd (umask may have cut it).
    if (kind === "none" && st.size === 0) fchmodSync(fd, 0o600)
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data
    const n = writeSync(fd, buf, 0, buf.byteLength)
    if (n !== buf.byteLength) return { error: "write failed" }
    return { ok: true }
  } catch {
    return { error: "write failed" }
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd)
      } catch {
        // already closed
      }
    }
  }
}

/**
 * Rename root/fromRel to root/toRel. Both ends are root-confined (same checks as
 * writeFileIn). The source must be a regular file (lstat, never followed). A target that
 * exists must be a regular file too (it is replaced). Creates missing parent dirs (0700)
 * of the target inside root. rename never follows a final link. Never throws.
 */
export function renameFileIn(root: string, fromRel: string, toRel: string): FsResult<never> {
  try {
    const a = resolveIn(root, fromRel)
    if ("error" in a) return a
    const b = resolveIn(root, toRel)
    if ("error" in b) return b
    const ka = targetKind(a.target)
    if (ka === "none") return { error: "missing" }
    if (ka !== "file") return { error: ka }
    const kb = targetKind(b.target)
    if (kb !== "none" && kb !== "file") return { error: kb }
    const dir = dirname(b.target)
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch {
      return { error: "write failed" }
    }
    const pa = checkParent(a.rootReal, dirname(a.target))
    if (pa !== null) return { error: pa }
    const pb = checkParent(b.rootReal, dir)
    if (pb !== null) return { error: pb }
    renameSync(a.target, b.target)
    return { ok: true }
  } catch (e) {
    return { error: codeOf(e) === "ENOENT" ? "missing" : "write failed" }
  }
}

/**
 * Remove root/relPath. Regular file only: lstat first (never followed), a symlink is
 * "target is a symlink", a dir or other entry is "not a file". Unlink only after the
 * lstat. unlink never follows a final link. Same root refusals as writeFileIn. Never
 * throws.
 */
export function removeFileIn(root: string, relPath: string): FsResult<never> {
  try {
    const r = resolveIn(root, relPath)
    if ("error" in r) return r
    const kind = targetKind(r.target)
    if (kind === "none") return { error: "missing" }
    if (kind !== "file") return { error: kind }
    unlinkSync(r.target)
    return { ok: true }
  } catch (e) {
    return { error: codeOf(e) === "ENOENT" ? "missing" : "write failed" }
  }
}
