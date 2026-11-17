<ma::agent::reflection-checkpoint round="%%round%%" cooldown-applied-seconds="%%cooldownSec%%" />
This checkpoint is soft. It is not a signal to stop. Briefly examine if your work still moves toward the goal. Then do one of these steps:

- Continue.
- Change your strategy.
- Pause and ask the user.

To prevent the next K checkpoints, write `<ma::agent::reflection-ack silence-for="K" reason="..." />` as inline text in your response body. You can put the tag at any position in the response body. Do not write it as a tool call. For these K checkpoints, the harness does not apply the cooldown and does not add this attachment.
