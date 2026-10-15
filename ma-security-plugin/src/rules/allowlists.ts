// Shared allowlists. Data only. The engine applies them to captures.
import type { AllowlistId } from "./types.ts"

export type Allowlist = {
  /** Regex sources tested against the whole capture ("i" flag, no "u" or "v"). */
  readonly patterns: readonly string[]
  /** Lowercase words. A capture that contains one is allowed. */
  readonly words: readonly string[]
}

/** Placeholders and template references (F7, B section 2.2). */
export const placeholder: Allowlist = {
  patterns: [
    "^\\$\\{[^}]{1,200}\\}$",
    "^<[^>]{1,200}>$",
    "^\\{\\{[^}]{1,200}\\}\\}$",
    "^\\$\\{\\{\\s{0,4}secrets\\.[A-Za-z0-9_]{1,100}\\s{0,4}\\}\\}$",
    "^%[A-Za-z0-9_]{1,100}%$",
    "^@[A-Za-z0-9_]{1,100}@$",
  ],
  words: ["changeme", "example", "xxx", "test", "dummy"],
}

/** Global allowlist shapes, rewritten by us after the gitleaks global allowlist. */
export const gitleaksGlobal: Allowlist = {
  patterns: [
    "^\\$[A-Za-z_][A-Za-z0-9_]{0,100}$",
    "^(?:true|false|null|none|nil|undefined)$",
    "^(.)\\1{0,500}$",
    "^/(?:bin|dev|etc|lib|opt|proc|sbin|sys|tmp|usr|var)(?:/[^\\s]{0,200})?$",
  ],
  words: [],
}

/** Alphabet runs and common words that show up in fake keys. */
export const stopwords: Allowlist = {
  patterns: [],
  words: [
    "abcdefghijklmnopqrstuvwxyz",
    "0123456789",
    "1234567890",
    "qwertyuiop",
    "password",
    "secret",
    "token",
    "sample",
    "placeholder",
    "redacted",
    "your_api_key",
    "your-api-key",
  ],
}

export const ALLOWLISTS: Readonly<Record<AllowlistId, Allowlist>> = {
  placeholder,
  "gitleaks-global": gitleaksGlobal,
  stopwords,
}
