Use `<ma::emit::output />` to render tool output or a file inline in the response stream. The bytes reach the user without a model copy step. Use it when the result has its final format. Use it when alignment or ANSI color matters. Use it also when a truncated preview hides content that the user needs. Do not use it on plain prose or on code that you can summarize. For anything that you can restate, write a normal reply.

## Invocation

Write `<ma::emit::output />` as a self-closing tag in your reply. Give it exactly one source attribute.

- `tool="call_00_xxx"` reads the raw-output blob of that tool call. Copy the id from the `<ma::agent::raw-output>` footer.
- `path="/abs/file.txt"` reads a file. The path must be under `/tmp/` or inside the working directory. The tag resolves symlinks first.

Add a `title` attribute for a dim heading. A blob is absent when the output was under 4 KiB. In that case, write the content to a file and use `path`.
