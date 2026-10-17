/**
 * Shell command parser for the security guards (design H).
 * Entry points: `parseCommand`, `walkCommands`, `collectCommands`, `gitSubcommand`, `rawScan`.
 */

export type * from "./ast.ts"
export { DEFAULT_LIMITS } from "./ast.ts"
export type { Flag, FlagSpec } from "./flags.ts"
export { FLAG_SPECS, FlagSet, GIT_SPECS, normalizeFlags } from "./flags.ts"
export { basename, decodeAnsiC } from "./lexer.ts"
export { parseCommand } from "./parse.ts"
export { rawScan, rawScanTruncated } from "./rawscan.ts"
export type { Interpreter, Unwrap } from "./unwrap.ts"
export { classify, DISPLAY_CMDS, FETCHERS, SHELLS, skipOptions } from "./unwrap.ts"
export type { ExecView, GitCall, LimitInfo, Origin, Visitor, WalkCtx, WalkOptions } from "./walk.ts"
export { collectCommands, gitSubcommand, walkCommands } from "./walk.ts"
