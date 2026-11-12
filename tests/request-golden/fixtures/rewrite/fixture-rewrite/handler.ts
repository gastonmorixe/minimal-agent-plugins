// Test fixture for the request golden harness. Not a real plugin.
/** Rewrites the Bash command and lets the call run. */
export default function handler(p: { input?: Record<string, unknown> }): { payload: unknown } {
  return { payload: { ...p, input: { ...p.input, command: "echo rewritten" } } }
}
