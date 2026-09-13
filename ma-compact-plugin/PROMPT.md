Use `CompactContext` to queue a context compaction: the host checkpoints the conversation and prunes older history.

## Two triggers

- **Manual.** The user asks to compact, clean up, or shorten context (or types `/compact`, which routes here). Pass `reason: "manual"`.
- **Auto.** You decide context is heavy, even unasked. Pass `reason: "auto"` (the default, so you can omit it).

## When to call it yourself (auto)

- `SessionInfo` shows high context fullness (70%+ is a good rule).
- History is very long and recall is degrading.
- Before a big new task phase, to start from a clean checkpoint.

## What it does

Validates args, queues the request through the host's `context:compact` seam, returns `queued:true` plus a human message. The rewrite happens after this turn. Continue with the retained tail. It never compacts mid-turn.

## Args

- `mode`: `tail` (keep last N verbatim, instant, no summary), `local` (checkpoint summary plus tail, default), `remote` (provider endpoint with local fallback), `fork` (checkpoint for a sub-agent handoff).
- `tail`: trailing messages kept verbatim. Default 6. `tail: 0` keeps only the checkpoint.
- `focus`: hint kept verbatim in the checkpoint. Say what the next step needs.
- `reason`: `manual` (user asked) or `auto` (you decided). Default `auto`.

## Examples

    CompactContext({mode: "local", focus: "keep the API list for the next step"})
    CompactContext({mode: "tail", tail: 10, reason: "manual"})

## Limits

- No mid-tool-loop compaction. When the tail is a pending tool call, finish the loop first.
- A host refusal (`queued: false`) means retry later or tell the user.
