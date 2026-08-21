# ma-tps-plugin

Real-time tokens-per-second readout for the minimal-agent footer, rendered
inline on the same line as the quota readout, in faint text: `42/tps`.

## How it works

The host emits an `llm.outputDelta` bus event per batched stream chunk
(~4 chars/token, batched at 250ms/50 tokens) from the single funnel every
provider's stream passes through. This plugin subscribes to that channel,
feeds each delta into a sliding window (last 10s), and reports
tokens-in-window / window-span as the rate.

- **Genuinely live.** The signal advances DURING generation — unlike
  session-token counters, which fold once per API call and can only ever
  produce stale per-call averages.
- **Sustained rate, not bursts.** Windowed math keeps clustered samples
  from spiking the number.
- **Inline placement.** The readout sits right after the status line's last
  segment (sid/name) with a normal two-space gap. No forced re-renders: the
  slot refreshes hourly by timer; each delta event triggers an immediate,
  cheap tail update via `refreshOn`.
- **Hides when the stream ends.** The host emits `llm.outputEnd` once
  the generation stream tears down (before tool IO). The readout clears
  immediately. A 2.5s idle fallback covers a missed end signal.

## Requirements

- **Requires a companion footer plugin (quota-status).** The host drops
  footer tails when there are no other footer lines, so standalone TPS
  renders nowhere by design — the whole point is sharing the quota line.
  Tails always ride the bottom-most footer line; without quota-status that
  may be a different line (e.g. the intercom roster), which still renders
  but not on the status line.

## Architecture

Pure plugin plus two small additive host seams:

- `core/src/llm/transport/stream-delta.ts` — batched accumulator that
  converts streamed text/thinking deltas into approximate token counts and
  emits `llm.outputDelta` on the plugin bus (250ms/50-token batches).
- `plugin-api/src/utils/footer-tail.ts` + `LiveAreaHandlerContext.setFooterTail`
  — keyed multi-writer tail registry; the scheduler appends the tail inline
  after the LAST footer line so concurrent plugins never clobber each other.
  Legacy `setDecorationSuffix` behavior is byte-identical when no tails
  exist (pinned by test).

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Slot declaration + `events[]` subscription to `llm.outputDelta` |
| `handler.ts` | Slot handler: read tracker → publish tail. Always returns null (tail-only visual) |
| `on_output_delta.ts` | Event handler: feed one delta batch into the shared tracker |
| `tps-tracker.ts` | Pure TPS math: sliding window over deltas, sticky display, idle decay |
| `render.ts` | Pure formatter: faint `N/tps` |
| `tracker-holder.ts` | Shared tracker singleton bridging event handler and slot handler |
| `host-types.ts` | Structural mirrors of the host slices consumed (no host imports) |
