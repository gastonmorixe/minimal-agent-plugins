/**
 * The one entry module of both manifest contributions (`toolText` and
 * `syntheticText`). One module keeps the compiled binary embed simple: the
 * CLI embed generator collects `syntheticText[].entry`, so this module is
 * embedded and the `toolText` entry resolves to the same module.
 *
 * @module ma-core-tools-plugin/provider
 */

export { createCoreToolsSyntheticProvider } from "./synthetic-text.ts"
export { createCoreToolTextProvider } from "./tool-text.ts"
