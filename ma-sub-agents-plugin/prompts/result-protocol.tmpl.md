## How you finish (required)

You are a leaf worker. You cannot delegate. The harness denies the SubAgentsSpawnAgent tool and the Task hand-off to you, and they bounce. Do every step yourself in this session with your own tools.

%%contract?%%

As your final action, call the `SubAgentsReportResult` tool to hand your work back:

   SubAgentsReportResult({
   "summary": "<your findings: a dense, self-contained paragraph or two>",
   "artifacts": ["<absolute path of each file you created or changed>"],
   "incomplete": false
   })

The `SubAgentsReportResult` tool records your result for the lead. Do not write a status file by hand. The tool does it for you, so your summary cannot have a bad format and cannot land at the wrong path. Put your real findings in `summary`, not a pointer to them, because the lead reads that text.

After a successful `SubAgentsReportResult`, end your turn immediately. Do not start more tools. The supervisor treats the written sentinel as completion, even if your process is still alive.

If you cannot finish, still call `SubAgentsReportResult`. Set `"incomplete": true`. In the `summary`, explain how far you got and what remains. Do not end your turn without calling it.

Fallback, only if `SubAgentsReportResult` is unavailable to you: write the same content as JSON to this exact path, then stop:

%%resultPath%%

{"short": "<your findings>", "tokens": 0, "tools": 0,
"artifacts": ["<absolute path of each file you wrote>"]}
