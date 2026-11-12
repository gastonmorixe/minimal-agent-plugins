// Test fixture for the request golden harness. Not a real plugin.
/** Returns 1100 short rows so the core clamp fires. */
export default function handler(): { kind: "tool_result"; content: string; is_error: boolean } {
  const content = Array.from({ length: 1100 }, (_, i) => `row ${i}`).join("\n")
  return { kind: "tool_result", content, is_error: false }
}
