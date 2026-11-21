During long work without the user, you can prevent the next K checkpoints. To do this, write `<ma::emit::reflection-ack silence-for="K" reason="..." />` as text in your response body. The position of the tag in the response body is not important. Do not use a tool for it. For these K checkpoints, the harness does not wait and does not add the checkpoint text.

The user can see the `reason` in the transcript. The `reason` gives the user the cause.
