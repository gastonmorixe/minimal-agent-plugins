Read a file from the local filesystem.

For a text file, the tool gives the contents with `cat -n` line numbers. Do not put a line-number prefix in an `Edit` `old_string`. For an image file (PNG, JPEG, GIF or WebP), the tool gives the image, not text. Use it to see a screenshot.

The text output has a limit of ~64KB / 1000 lines. For a larger file, read pages with `offset` (the zero-based start line) and `limit` (the maximum number of lines). `offset` and `limit` apply to text only.
