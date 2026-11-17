Read a file from the local filesystem.

For a text file, the tool gives the contents with line numbers in the `cat -n` format. The line numbers help you find text. `Edit` has no line-number input. Do not put the line-number prefix in `old_string`.

For an image file (PNG, JPEG, GIF or WebP), the tool gives the image to you, not text. You can see this image only if the active model accepts image input. To examine an image, Read its path. For example: a screenshot, a diagram, or an image that a tool wrote to disk. One example is a `Computer` screenshot path.

If an image file has too many bytes, the harness makes the image smaller before it sends the image. The smaller image fits the limit of the model. You do not have to make the image smaller. If the image has too many pixels, Read gives an error message. Read also gives an error message if the harness cannot make the image fit the limit. Do not try to read image bytes as text.

If the model cannot accept images, Read gives a short message, not bytes that you cannot read. Read does the same for a binary document (PDF), because tool output cannot contain a document. The message tells you the steps to do as an alternative.

For each use of the tool, the text output that you receive has a limit of ~64KB / 1000 lines. The transcript of the user shows only the first ~15 lines and a summary of the remaining lines. For a larger file, read the file in pages with `offset` and `limit`. `offset` is the zero-based start line. `limit` is the maximum number of lines.

The `[truncated:` message gives the cut line and the total length of the file. Use these values to select the next `offset`. Read does not divide an image into line pages. `offset` and `limit` apply to text only.
