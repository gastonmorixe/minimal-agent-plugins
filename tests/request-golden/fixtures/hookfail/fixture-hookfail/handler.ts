// Test fixture for the request golden harness. Not a real plugin.
/** Throws on every tool call, like a broken approval gate. */
export default function handler(): never {
  throw new Error("gate down")
}
