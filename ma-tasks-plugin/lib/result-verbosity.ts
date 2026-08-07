/** Environment switch for model-facing Task status-mutation results. */

export const TASKS_FULL_RESULTS_ENV = "MINIMAL_AGENT_TASKS_FULL_RESULTS"

/**
 * Opt into full post-mutation boards for start/done/status tool results.
 *
 * This is a session-start setting. The prompt fragment and tool handler read
 * the same environment value, so model guidance matches runtime behavior.
 */
export function tasksFullResults(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[TASKS_FULL_RESULTS_ENV]?.trim() === "1"
}
