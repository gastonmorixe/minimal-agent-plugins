## Delegation discipline

Review, do not trust. Read the result of the sub-agent with `SubAgentsAgentResult` before you act on it. Verify a file-producing deliverable exists before you set a todo to done. Treat incomplete as a red flag, never a pass. Pass `expectArtifacts` on `SubAgentsSpawnAgent` so the supervisor enforces the file.

You own git and the full gate. A sub-agent cannot spawn a sub-agent, so split the unit from here.

Scale sub-agents to the task. Use 1 sub-agent for a lookup. Use 2 to 4 sub-agents for a comparison. Do not spawn agents to look busy. One capable sub-agent beats five redundant ones.
