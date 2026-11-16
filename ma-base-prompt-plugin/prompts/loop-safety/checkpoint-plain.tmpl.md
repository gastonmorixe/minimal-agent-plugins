A reflection checkpoint occurs every %%interval%% tool rounds. The harness adds a `<ma::agent::reflection-checkpoint round="N" cooldown-applied-seconds="0" />` attachment to the next user content. The checkpoint is soft. It is not a stop signal.

Briefly examine if your work still moves toward the goal. Then do one of these steps:

- Continue.
- Change your strategy.
- Pause and ask the user.

To prevent checkpoints, write `<ma::agent::reflection-ack silence-for="K" reason="..." />` as inline text in your response body. Do not write it as a tool call.
