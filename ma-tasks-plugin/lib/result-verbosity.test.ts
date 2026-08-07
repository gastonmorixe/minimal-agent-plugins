import { describe, expect, test } from "bun:test"

import { TASKS_FULL_RESULTS_ENV, tasksFullResults } from "./result-verbosity.ts"

describe("tasksFullResults", () => {
  test("is opt-in through an exact 1", () => {
    expect(tasksFullResults({ [TASKS_FULL_RESULTS_ENV]: "1" })).toBe(true)
    expect(tasksFullResults({ [TASKS_FULL_RESULTS_ENV]: " 1 " })).toBe(true)
  })

  test("defaults to compact for missing or other values", () => {
    expect(tasksFullResults({})).toBe(false)
    expect(tasksFullResults({ [TASKS_FULL_RESULTS_ENV]: "" })).toBe(false)
    expect(tasksFullResults({ [TASKS_FULL_RESULTS_ENV]: "0" })).toBe(false)
    expect(tasksFullResults({ [TASKS_FULL_RESULTS_ENV]: "true" })).toBe(false)
  })
})
