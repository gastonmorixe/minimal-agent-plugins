The lead requires these files. Each one must exist and not be empty when you finish:

%%paths%%

Deliver each required file through `SubAgentsReportResult.deliverables`. Give the full file text, and the tool writes the file for you:

   "deliverables": [{ "path": "<one required path>", "content": "<full file text>" }]

This works in every mode, also read-only. If you can edit files, you can write a required file first. Then list it in `artifacts` only. `SubAgentsReportResult` returns an error and records nothing while a required file is missing. If you cannot make the file, set `"incomplete": true` and give the reason.
