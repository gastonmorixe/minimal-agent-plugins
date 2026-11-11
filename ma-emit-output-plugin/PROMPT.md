Use `<ma::emit::output />` to render tool output or a file inline in the response stream. The bytes reach the user without a model copy step. Use it when a result is already formatted. Use it when alignment or ANSI color matters, or when a truncated preview hides content the user needs. Do not use it on plain prose or code that you can summarize. Write a normal reply instead for anything you can restate.

## Invocation

Write `<ma::emit::output />` as a self-closing tag in your reply. Give it exactly one source attribute.

- `tool="call_00_xxx"` reads the raw-output blob of that tool call. Copy the id from the `<ma::agent::raw-output>` footer.
- `path="/abs/file.txt"` reads a file. The path must be under `/tmp/` or inside the working directory. Symlinks are resolved first.

Add a `title` attribute for a dim heading. If a blob does not exist because the output was under 4 KiB, write the content to a file and use `path`.
