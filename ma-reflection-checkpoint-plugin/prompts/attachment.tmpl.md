<ma::agent::reflection-checkpoint round="%%round%%" cooldown-applied-seconds="%%cooldownSec%%" />
This checkpoint is soft. It is not a signal to stop. Quickly examine if your work continues in the correct direction. Then do one of these steps:

- Continue.
- Change your method.
- Stop and speak to the user.

To prevent the next K checkpoints, write `<ma::emit::reflection-ack silence-for="K" reason="..." />` as text in your response body. The position of the tag in the response body is not important. Do not use a tool for it. For these K checkpoints, the harness does not wait and does not add this text.
