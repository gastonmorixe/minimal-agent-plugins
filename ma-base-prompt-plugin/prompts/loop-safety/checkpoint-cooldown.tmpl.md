A reflection checkpoint occurs every %%interval%% tool rounds. First, the harness waits %%cooldownSec%% seconds of wall-clock time. During this wait, a user who watches can push Esc to stop the wait. Then the harness adds a `<ma::agent::reflection-checkpoint round="N" cooldown-applied-seconds="%%cooldownSec%%" />` attachment to the next user content. The checkpoint is soft. It is not a stop signal.

Briefly examine if your work still moves toward the goal. Then do one of these steps:

- Continue.
- Change your strategy.
- Pause and ask the user.

To prevent checkpoints, write `<ma::agent::reflection-ack silence-for="K" reason="..." />` as inline text in your response body. Do not write it as a tool call.
