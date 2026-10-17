import { expect, test } from "bun:test"

import { resolvePolicy } from "../config/resolve.ts"
import { buildSecurityStatus, type SecurityStatusInput } from "../status.ts"

test("disabled built-in warning precedes the report and preserves the fixed reason", () => {
  const report = buildSecurityStatus({
    disabledRules: [{ id: "pii.email", reason: "bench", builtin: true }],
  })
  expect(report.text.startsWith("built-in rule disabled: pii.email (bench)\n")).toBe(true)
  expect(report.json.disabledRules[0]).toMatchObject({
    id: "pii.email",
    reason: "bench",
    builtin: true,
  })
})

test("malformed lead floor is visible directly from resolved policy drops", () => {
  const policy = resolvePolicy({ env: { MINIMAL_AGENT_SECURITY_RESOLVED: "bad json" } })
  const report = buildSecurityStatus({ policy })
  expect(report.json.malformedLeadFloor).toBe(true)
  expect(report.json.notices).toContain("malformed lead floor: steer floor applied")
})

test("audit degradation and reasons cannot carry arbitrary text", () => {
  const sentinel = "SENTINEL_STATUS_AUDIT_12"
  const report = buildSecurityStatus({
    audit: { auditWriteErrors: 7, degraded: true, errorReason: sentinel },
  } as unknown as SecurityStatusInput)
  expect(report.json.audit.auditWriteErrors).toBe(7)
  expect(report.json.audit.degraded).toBe(true)
  expect(JSON.stringify(report)).not.toContain(sentinel)
})
