/**
 * Speech failure taxonomy.
 *
 * Turns an opaque backend failure (exit code + stderr) into a short,
 * **backend-agnostic** reason string that is always safe to hand the model.
 * No raw stderr, no engine identity, ever. The model knows it has a tool that
 * speaks; it must not learn which speech engine ran or why it failed in
 * engine-specific terms.
 *
 * @module lib/errors
 */

/** Backend-agnostic failure taxonomy. */
export type SpeechErrorKind =
  | "engine-unavailable" // backend script missing / failed to spawn / binary not found
  | "audio-unavailable" // no audio output device / sound system error
  | "interrupted" // killed by stop() or parent-exit
  | "unknown" // unclassified non-zero exit

/** A classified failure: a stable kind plus a model-safe message. */
export interface SpeechFailure {
  kind: SpeechErrorKind
  /** Hand-written, engine-free message safe to surface to the model. */
  message: string
}

/**
 * Classify a backend failure into a backend-agnostic {@link SpeechFailure}.
 *
 * Inspects exit code + stderr for well-known signatures. The returned message
 * contains NO raw stderr and NO engine identity. Anything unrecognized maps to
 * `kind: "unknown"` with a generic message.
 */
export function classifySpeechFailure(opts: {
  exitCode: number
  stderr: string
  killed?: boolean
}): SpeechFailure {
  if (opts.killed) {
    return { kind: "interrupted", message: "Speech was stopped before it finished." }
  }

  const s = opts.stderr.toLowerCase()

  if (/command not found|no such file|enoent|not installed|spawn .* failed/.test(s)) {
    return {
      kind: "engine-unavailable",
      message: "The speech engine is unavailable on this machine.",
    }
  }

  if (/audio|coreaudio|sound|output device|no default device|alsa|pulse/.test(s)) {
    return {
      kind: "audio-unavailable",
      message: "Audio output is unavailable, so the text could not be spoken.",
    }
  }

  return { kind: "unknown", message: "The text could not be spoken." }
}

/** Convenience: the failure for a missing/unspawnable backend script. */
export function engineUnavailable(): SpeechFailure {
  return {
    kind: "engine-unavailable",
    message: "The speech engine is unavailable (ma-speak plugin misconfiguration).",
  }
}
