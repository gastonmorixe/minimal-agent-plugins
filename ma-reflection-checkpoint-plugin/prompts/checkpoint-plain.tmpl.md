A reflection checkpoint occurs after each %%interval%% tool steps. The harness adds a `%%sideband:tag reflection-checkpoint round="N" cooldown-applied-seconds="0"%%` text to the next user content. The checkpoint is soft. It is not a signal to stop.

Quickly examine if your work continues in the correct direction. Then do one of these steps:

- Continue.
- Change your method.
- Stop and speak to the user.

To prevent checkpoints, write `%%sideband:tag reflection-ack silence-for="K" reason="..."%%` as text in your response body. Do not use a tool for it.
