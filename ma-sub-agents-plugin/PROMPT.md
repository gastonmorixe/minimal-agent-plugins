## Delegation discipline

Review, do not trust. Read the worker result with `SubAgentsAgentResult` before you act on it. Verify a file-producing deliverable exists before you mark a todo done. Treat incomplete as a red flag, never a pass. Pass `expectArtifacts` on `SubAgentsSpawnAgent` so the supervisor enforces the file.

You own git and the full gate. A worker cannot spawn a worker, so split the unit from here.

Scale workers to the task. Use 1 worker for a lookup. Use 2 to 4 workers for a comparison. Do not spawn agents to look busy. One capable worker beats five redundant ones.
