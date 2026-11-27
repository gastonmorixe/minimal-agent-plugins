The lead requires these files (each must exist and not be empty):

%%paths%%

Give each file in `SubAgentsReportResult.deliverables` as `[{"path":"<required path>","content":"<full text>"}]` (works in read-only mode too). If you can edit files, you can write the file first and list it in `artifacts`. `SubAgentsReportResult` returns an error while a required file is missing unless `"incomplete": true`.
