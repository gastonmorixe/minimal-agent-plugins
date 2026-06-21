# Intercom: talking to other sessions

Other minimal-agent sessions may be running right now on this machine, in other
terminals and other projects. Intercom lets you see them and message them. It has
three tools: `IntercomPeers` (who is out there and what they are doing), `IntercomSend` (message
one peer or many), and `IntercomInbox` (re-read what you got).

Intercom is peer-to-peer between independent top-level sessions. It differs from
`SubAgentsMailbox`: `SubAgentsMailbox` talks to the sub-agent workers you spawned inside one
delegation, while `Intercom` reaches whole sessions you did not spawn, like a
different human, another project, or another window. Rule of thumb: workers you
launched go through `SubAgentsMailbox`, separate sessions go through `Intercom`. A
sub-agent worker is never an intercom peer.

## Seeing other sessions

`IntercomPeers({action:"list"})` returns the roster: every messageable session with its
short id (the 6-char handle everyone uses), its derived liveness, its model, its
cwd, and what it is working on. Only sessions actually running intercom appear, so
anyone on the list can receive a message from you. A row reads like this:

    a1b2c3d4  [online]  claude-opus-4   minimal-agent - refactoring auth
    d4e5f6a7  [idle]    claude-sonnet   api-gateway - waiting on review

Liveness is derived, not self-claimed. A session publishes a heartbeat (its pid
plus a timestamp) every few seconds, and the roster decides what that means:

- `online` / `idle` / `busy`: beating normally. `busy` means a turn is running.
- `stale`: not beating on schedule, on another host we cannot probe. Maybe alive.
- `hung`: its process is alive but it stopped beating. Wedged or suspended.
- `dead`: its process is gone. It crashed or was killed.
- `offline`: it exited cleanly, or has not been seen in a long time.

A session that died without cleaning up still reads correctly (stale, then dead),
and one that is merely quiet between turns still reads `online`. Trust the verdict.
Pass `liveOnly:true` to hide the dead and offline sessions and see only reachable
peers.

`IntercomPeers({action:"inspect", peer:"a1b2c3d4"})` is the deep dive on one session. It
gathers that peer's state from across plugins: its task list, recent activity,
background jobs, and sub-agent fleet, plus an optional transcript excerpt. Use it
to understand what a peer is actually doing before you message it, not just that
it is alive. Choose sections with
`include:["tasks","activity","jobs","fleet","transcript"]`; the default is tasks,
activity, and jobs.

## Messaging

`IntercomSend({to, body, kind})` delivers a message to one peer or a group.

- `to` is a peer's short id or full session id, or `"all"` to reach every
  reachable session, or `"project"` to reach sessions in your project directory.
- `body` is the message text. Keep it short and self-contained.
- `kind` is `"message"` (default) or `"interrupt"`:
  - `message`: queued if the recipient is mid-turn, wakes them between turns
    if idle. Use it for everything: coordination, handoffs, results, questions.
    The recipient sees the message and processes it on its next turn. Always
    visible in the terminal TUI.
  - `interrupt`: same delivery behavior (the host mid-turn preemption hook is
    not yet built), but signals urgency. The TUI renders it with a distinctive
    glyph. Use rarely, for "stop, the plan changed" situations.

A normal send reads like this:

    IntercomSend({to:"a1b2c3d4", body:"finished the auth refactor, your turn on the API"})

The roster shows the 8-char handle, but `to` and `peer` accept any prefix of a
session id or the full id, so `"a1b2"`, `"a1b2c3d4"`, and the whole uuid all
resolve to the same peer. You cannot message yourself. If a prefix is unknown or
matches more than one session, `IntercomSend` says so; run `IntercomPeers` to get the right
handle. Add `replyTo` with a message id to thread a reply (display only).

## Receiving is automatic

You do not poll for messages. When another session sends to you, the message
arrives on its own as a `<ma::agent::intercom-inbox>` block at the start of your
next turn, with the sender's identity attached. Read it and act. A block reads
like this:

    <ma::agent::intercom-inbox count="1">
    [message] from a1b2c3d4 (claude-opus-4 cwd=api-gateway) id=k7p2n9 at 2026-06-13T15:02:11Z
        finished the auth refactor, your turn on the API
    </ma::agent::intercom-inbox>

A message also prints to the terminal as soon as it lands, even when the agent
is mid-turn or idle. You see a notification like this:

    `⇆ ◇ 9f7c8612 (gpt-5.5) at 00:34:17`
    `  Reply from session 9f7c8612...`

If you are idle, the sender's message wakes you between turns with a nudge so you
process it sooner.

Two things to keep in mind:

- Dedup on the message `id`. Delivery is at-least-once, so on a rare retry (a
  crash mid-delivery) you might see one message twice. If you already acted on an
  `id`, skip the repeat.
- Any message wakes you between turns with a one-line nudge. The full
  message is in the `<ma::agent::intercom-inbox>` block, not the nudge, so read the
  block before you reply.

`IntercomInbox({scope})` only re-reads what already arrived: `scope:"recent"` for the
latest messages, `scope:"unread"` for anything since your last `IntercomInbox` read. You
rarely need it, because delivery already happens on its own.

## Good habits

- Before you broadcast, run `IntercomPeers list` so you know who will actually receive it.
- Run `IntercomPeers inspect` on a peer before you ask something its task list already
  answers.
- Keep messages short and self-contained. The recipient is a different session
  with none of your context, so say who you are and what you need.
- Do not chatter. Use intercom for coordination that matters: handing off a
  result, claiming a shared resource, flagging a blocker, asking a peer to stop. It
  is not a place for running commentary.
