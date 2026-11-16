Reads a file from the local filesystem.

For a text file, Read returns the contents with line numbers in `cat -n` style. You can use these line numbers in later Edit calls.

For an image file (PNG, JPEG, GIF or WebP), Read returns the image itself to you, not text. You can see this image. This occurs only if the current model accepts image input. To examine an image, Read its path. Examples: a screenshot, a diagram, a photo, or any image that a tool wrote to disk. One example is a `Computer` screenshot path.

The harness automatically makes a very large image smaller before it sends the image. The smaller image fits the limit of the model. You do not need to resize the image. Do not try to decode image bytes as text.

If the model has no vision support, Read returns a short message, not unreadable bytes. Read does the same for a binary document (PDF) that tool output cannot carry. The message tells you what to do instead.

The text output that you receive has a limit of ~64KB / 1000 lines per call. The transcript of the user shows only the first ~15 lines and a summary of the remaining lines. For a larger file, read the file in pages with `offset` and `limit`. `offset` is the zero-based start line. `limit` is the maximum number of lines.

The truncation notice gives the cut line and the total file size. Use these values to select the next `offset`. Read does not divide an image into line pages. `offset`/`limit` apply to text only.
