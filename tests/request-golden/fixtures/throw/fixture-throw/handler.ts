// Test fixture for the request golden harness. Not a real plugin.
/** Always throws. */
export default function handler(): never {
  throw new Error("boom")
}
