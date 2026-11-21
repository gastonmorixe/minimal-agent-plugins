Read and change the permanent memory entries of the user, and the short-term entries of this session. Use it when the user tells you to show your memory. Use it before you debug a symptom that you know, or before you save an entry with new information.

To save during a response, use the `<ma::emit::memory>` tag, not `add`. Do not save a secret.

The tool gives entries with the id, the timestamp and the body. The first line of `list` gives the total. `clear` gives the number of removed entries.