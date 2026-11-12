/**
 * Ambient module type for `with { type: "text" }` markdown imports.
 *
 * Plugins load their own prompt files (`prompts/*.md`) through text imports
 * instead of disk reads, so the text is inlined by Bun and works both from the
 * on-disk checkout and from a compiled binary (where plugin files are not on
 * disk). See `tests/embed-safety.test.ts`.
 */
declare module "*.md" {
  const text: string
  export default text
}
