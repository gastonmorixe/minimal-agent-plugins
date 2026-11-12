// Test fixture for the request golden harness. Not a real plugin.
/** Adds two notes to the tool.didInvoke payload. */
export default function handler(p: { notes?: string[] }): { payload: unknown } {
  return { payload: { ...p, notes: [...(p.notes ?? []), "fixture note one", "fixture note two"] } }
}
