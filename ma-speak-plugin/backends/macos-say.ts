#!/usr/bin/env bun
/**
 * macOS `say` backend for the Speak tool.
 *
 * Two roles in one file:
 *
 *   1. **Executable** (when run as `bun backends/macos-say.ts`):
 *      reads the utterance from STDIN, reads `MA_SPEAK_*` env vars, builds
 *      the `say` argv, spawns it, and propagates its exit code. The text
 *      arrives on stdin (not argv) so it dodges argv length limits and never
 *      shows up in `ps` output.
 *
 *   2. **Library** (when imported by tests): exports the pure `buildArgv()`
 *      and `parseEnv()` so argv assembly is unit-testable without spawning
 *      a real `say`.
 *
 * The handler in `handlers/speak.ts` only knows the executable role: it
 * spawns this file and treats it as a black box. Tomorrow's
 * `backends/elevenlabs.ts` honors the same contract (read text on stdin,
 * read `MA_SPEAK_*`, write nothing to stdout, exit 0 on success) and the
 * handler stays unchanged.
 *
 * ## Env-var contract (subprocess input)
 *
 *   MA_SPEAK_BIN     (optional)  path to the speech binary (default: `say` on PATH)
 *   MA_SPEAK_VOICE   (optional)  voice name → `say -v <voice>`. Best left unset:
 *                                with no -v, `say` uses the system default
 *                                (Premium Siri neural voice), which sounds
 *                                better than any name-addressable voice.
 *   MA_SPEAK_RATE    (optional)  words per minute → `say -r <rate>`
 *
 * ## Output contract
 *
 *   stdin   ← the text to speak (UTF-8)
 *   stdout  → nothing (the "output" is audio)
 *   stderr  → diagnostics (verbatim from `say`)
 *   exit    → `say`'s exit code (0 = success)
 *
 * @module backends/macos-say
 */

export interface SayArgvOptions {
  /** Voice name (e.g. `Samantha`). Forwarded as `-v <voice>`. */
  voice?: string
  /** Speech rate in words per minute. Forwarded as `-r <rate>`. */
  rate?: number
}

/**
 * Build the argv passed to `say`. Pure - no IO, no env.
 *
 * The text is NOT in argv. We pass `-f -` so `say` reads the utterance from
 * stdin. That keeps arbitrarily long text working and avoids leaking the
 * spoken text into the process table.
 *
 * When no voice is given we omit `-v` entirely, so `say` falls back to the
 * system default voice (the Premium Siri neural voice from System Settings).
 * That is the highest-quality option and the intended default.
 *
 * Invariants:
 *   - `-f -` is always present (read text from stdin).
 *   - `-v` / `-r` appear only when provided.
 */
export function buildArgv(opts: SayArgvOptions): string[] {
  const argv: string[] = []
  if (opts.voice && opts.voice.length > 0) {
    argv.push("-v", opts.voice)
  }
  if (typeof opts.rate === "number" && Number.isFinite(opts.rate) && opts.rate > 0) {
    argv.push("-r", String(Math.floor(opts.rate)))
  }
  argv.push("-f", "-")
  return argv
}

/** Read `MA_SPEAK_*` env vars into {@link SayArgvOptions}. Pure. */
export function parseEnv(env: Record<string, string | undefined>): SayArgvOptions {
  const out: SayArgvOptions = {}
  const voice = env.MA_SPEAK_VOICE?.trim()
  if (voice) out.voice = voice
  const rateRaw = env.MA_SPEAK_RATE?.trim()
  if (rateRaw) {
    const rate = Number(rateRaw)
    if (Number.isFinite(rate) && rate > 0) out.rate = Math.floor(rate)
  }
  return out
}

// ---------------------------------------------------------------------------
// Subprocess entry point
// ---------------------------------------------------------------------------

/** Read all of stdin to a UTF-8 string. */
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk)
  }
  let total = 0
  for (const c of chunks) total += c.byteLength
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder("utf-8").decode(buf)
}

if (import.meta.main) {
  await main()
}

async function main(): Promise<never> {
  const text = await readStdin()
  if (text.trim().length === 0) {
    process.stderr.write("[ma-speak/macos-say] empty utterance on stdin\n")
    process.exit(2)
  }

  const bin = process.env.MA_SPEAK_BIN?.trim() || "say"
  const argv = [bin, ...buildArgv(parseEnv(process.env as Record<string, string | undefined>))]

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(argv, {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "inherit",
    })
  } catch (e) {
    process.stderr.write(`[ma-speak/macos-say] failed to start speech engine: ${String(e)}\n`)
    process.exit(127)
  }

  // Forward termination signals to `say` so a group-kill from the agent (or a
  // direct signal to this wrapper) stops the audio promptly.
  const forward = (sig: NodeJS.Signals) => {
    try {
      proc.kill(sig)
    } catch {
      // already gone
    }
  }
  process.on("SIGTERM", () => forward("SIGTERM"))
  process.on("SIGINT", () => forward("SIGINT"))
  process.on("SIGHUP", () => forward("SIGHUP"))

  // Feed the text to `say` on its stdin, then close. With `stdin: "pipe"`
  // the handle is a writable FileSink; guard the union Bun's types expose.
  const sink = proc.stdin
  if (sink && typeof sink !== "number") {
    try {
      // `write()` / `end()` may return a promise on a backed-up pipe; swallow
      // any rejection (the process may have died early — `exited` resolves
      // below and reports the failure).
      void Promise.resolve(sink.write(text)).catch(() => {})
      void Promise.resolve(sink.end()).catch(() => {})
    } catch {
      // if say died early, exited resolves below
    }
  }

  const code = await proc.exited
  process.exit(code ?? 1)
}
