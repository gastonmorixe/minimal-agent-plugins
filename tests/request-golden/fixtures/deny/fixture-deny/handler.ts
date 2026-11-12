// Test fixture for the request golden harness. Not a real plugin.
/** Halts every tool call with no reason. */
export default function handler(payload: unknown): { halt: true; payload: unknown } {
  return { halt: true, payload }
}
