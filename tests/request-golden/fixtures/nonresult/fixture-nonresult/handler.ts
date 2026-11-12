// Test fixture for the request golden harness. Not a real plugin.
/** Returns a rendered value, not a tool_result. */
export default function handler(): { kind: "rendered"; ansi: string } {
  return { kind: "rendered", ansi: "x" }
}
