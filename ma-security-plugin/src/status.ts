/**
 * Status report shared by the SecurityStatus tool and the /security command.
 *
 * @module src/status
 */

/** Skeleton status report. */
export interface SecurityReport {
  profile: "steer"
  phase: "skeleton"
}

/** Build the current status report. Pure and sync. */
export function buildReport(): SecurityReport {
  return { profile: "steer", phase: "skeleton" }
}

/** Report as one line of JSON text. */
export function reportText(): string {
  return JSON.stringify(buildReport())
}
