import type { ReadonlySidebandRegistry, SidebandAttrDecl, SidebandKind } from "./types.ts"

const S: SidebandAttrDecl = { type: "string" }
const I: SidebandAttrDecl = { type: "int" }

function decl(
  kind: string,
  attrs: Record<string, SidebandAttrDecl>,
  extra: Partial<SidebandKind> = {},
): SidebandKind {
  return {
    kind,
    owner: "test",
    direction: "to-model",
    placement: "tool-result",
    attrs,
    body: "none",
    trust: "harness",
    summary: "synthetic test kind",
    ...extra,
  }
}

/** Synthetic kind declarations for the 11 sideband rows, plus a from-model kind. */
export const TEST_KINDS: Record<string, SidebandKind> = {
  modeActive: decl("mode-active", { id: S, since: S }),
  modeChange: decl("mode-change", { from: S, to: S, at: S }),
  rawOutput: decl("raw-output", { path: S, size: S, sha256: S }),
  binaryResult: decl("binary-result", { mime: S, size: S, path: S, sha256: S, tool: S }),
  binaryBody: decl(
    "binary-result",
    { mime: S, size: S, encoding: S, path: S, sha256: S, tool: S },
    { body: "raw", layout: "block" },
  ),
  redactedAsset: decl("redacted-asset", { kind: S, mime: S, size: S, chars_removed: I, tool: S }),
  sanitizer: decl("context-sanitizer", { removed: I, kinds: S, chars_removed: I, saved: S }),
  diagnostics: decl(
    "diagnostics",
    { count: I, scope: { type: "enum", values: ["ad-hoc"] } },
    { body: "text", layout: "block" },
  ),
  policy: decl("policy", {}, { body: "text" }),
  sysTool: decl("tool", { name: S }, { body: "text", layout: "block", placement: "system" }),
  compaction: decl(
    "compaction",
    { kind: { type: "enum", values: ["tail", "local"] } },
    { placement: "turn" },
  ),
  reflectionAck: decl(
    "reflection-ack",
    { reason: S, "silence-for": I },
    { direction: "from-model", placement: "inline", legacy: ["ma::agent::reflection-ack"] },
  ),
  memorySaved: decl("memory-saved", { id: S }, { body: "text", placement: "turn" }),
  blockEscaped: decl(
    "short-term-memory",
    {},
    { body: "text", layout: "block", legacyBodyEscaped: true, placement: "turn" },
  ),
}

/** Build a read-only registry view over some kind declarations. */
export function makeRegistry(
  kinds: SidebandKind[] = Object.values(TEST_KINDS),
): ReadonlySidebandRegistry {
  return { kind: (name) => kinds.find((k) => k.kind === name), kinds: () => kinds }
}
