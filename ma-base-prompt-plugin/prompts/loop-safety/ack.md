During long autonomous work, you can prevent the next K checkpoints. To do this, write `<ma::agent::reflection-ack silence-for="K" reason="..." />` as inline text in your response body. You can put the tag at any position in the response body. Write the tag as plain text. Do not write it as a tool call. For these K checkpoints, the harness does not apply the cooldown and does not add the attachment.

The user can see the `reason` in the transcript. The `reason` tells the user why you prevented the checkpoints.
