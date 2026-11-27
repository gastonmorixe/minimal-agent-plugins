Use `%%sideband:tag output%%` to show tool output or a file in the response. The bytes reach the user without a copy by the model. Use it when the result has its final format. Use it also when alignment or ANSI color matters, or when a cut preview hides content that the user needs. Do not use it for plain prose. For anything that you can restate, write a normal reply.

## Invocation

Write `%%sideband:tag output%%` as a self-closing tag in your reply. Give it exactly one source attribute.

1. `tool="call_00_xxx"`: the raw-output blob of that tool call. Copy the id from the `%%sideband:open raw-output%%` footer.
2. `path="/abs/file.txt"`: a file. The path must be under `/tmp/` or inside the working directory. The tag resolves symlinks first.

Add a `title` attribute for a dim heading. A blob is absent when the output was under 4 KiB. Then write the content to a file and use `path`.
