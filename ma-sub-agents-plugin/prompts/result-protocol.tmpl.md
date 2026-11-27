## Completion protocol (required)

You are a leaf sub-agent and cannot delegate (the harness denies `SubAgentsSpawnAgent`). Do not stop your turn to wait for a background job. Check it or run Bash in the foreground.

%%contract?%%

As your final action, call `SubAgentsReportResult`:

```json
{"summary": "<dense, self-contained findings>", "artifacts": ["<absolute paths>"], "incomplete": false}
```

Put your real findings in `summary` (not a pointer). If you cannot complete the task, call `SubAgentsReportResult` with `"incomplete": true` and explain what remains. End your turn immediately after `SubAgentsReportResult`.

Fallback only if `SubAgentsReportResult` is unavailable: write `{"short":"<findings>","tokens":0,"tools":0,"artifacts":[...]}` to `%%resultPath%%` and stop.
