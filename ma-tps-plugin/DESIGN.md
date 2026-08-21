# ma-tps-plugin — Design

Real-time tokens-per-second readout in the footer, on the same line as the
quota readout, right-aligned. Faint/dim text, format `N/tps`.

## Problem shape

The user wants a live TPS number that updates ~1/sec while the model is
streaming, rendered at the far right of the existing quota footer line.

Constraints discovered in research:

1. **No per-chunk token events reach plugins.** The plugin event bus carries
   `quota.headersReceived` (fired by `signalQuotaRefresh()` after every
   completed API send) but nothing per SSE delta.
2. **Token accounting is per-API-call**, not per-user-turn: `addSessionUsage`
   folds one `usage` payload inside the `message_start` SSE case, so an
   agentic loop with N tool round-trips produces N folds. Good granularity
   for sampling.
3. **Each live-area slot paints its own footer row** (`LiveAreaScheduler`
   splits slot output into rows). A second plugin slot would stack a new
   line, not join the quota line.
4. **The decoration-suffix seam exists**: `ctx.setDecorationSuffix(text)`
   publishes a string the scheduler appends to the FIRST footer line (the
   quota line, when quota-status is present). `ma-diagnostics-plugin` already
   uses this to share the intercom roster line.

## Design

### Architecture: pure plugin + one small additive core seam

New package `ma-tps-plugin/` following the established plugin layout:

```
ma-tps-plugin/
├── manifest.json        # liveAreaSlots[0]: id "tps", position "footer",
│                        # refreshMs 1000, refreshOn ["quota.headersReceived"]
├── package.json         # same scripts pattern as siblings
├── tsconfig.json
├── host-types.ts        # structural mirrors: SessionTokensView slice,
│                        # SessionInfoReadApi slice, LiveAreaHandlerContext
│                        # slice (host + setFooterTail)
├── tps-tracker.ts       # pure TPS math: sampling + dt-weighted EMA +
│                        # spike guard + idle decay
├── render.ts            # pure formatter: "N/tps" faint styling
├── handler.ts           # slot handler: sample → track → render → publish
└── *.test.ts            # tracker/render + handler contract tests
```

Capabilities declared: `["session-info:read"]`.

### TPS computation (sampled deltas)

State machine in `TpsTracker`:

- **Sample**: on every handler invocation (1s timer tick OR
  `quota.headersReceived` off-cycle fire), read
  `ctx.host.sessionInfo.tokens().output` and record `(t, output)`.
- **Delta**: TPS between consecutive samples =
  `(output_now - output_prev) / dt_seconds`, only when `output_now >
  output_prev` (a fold happened between samples).
- **Smoothing**: dt-weighted EMA,
  `ema += alpha * (instant - ema) * min(dt, 1)`, `alpha = 0.4`. With
  `refreshOn` fires the sample cadence is irregular (dt can be << 1s during
  fast agentic loops); weighting each update by its dt keeps short-dt
  samples from over-contributing, and the `min(dt, 1)` cap keeps one huge
  gap from yanking the average. Reads as "current throughput" without raw
  delta jitter.
- **Idle decay**: when no positive delta has been observed for >5s, the
  tracker reports idle and the segment hides (returns null). No stale
  numbers lingering after a turn ends.
- **Spike guard**: an instant rate above 10,000 tok/s is treated as a
  counter discontinuity (e.g. a future resume re-seed) and resets the
  tracker instead of feeding the EMA. Real decode rates are O(10-200).
- **Counting scope**: OUTPUT tokens only (`tokens().output`). Cache-read and
  cache-create are excluded by construction since we never touch those
  fields. This measures generation throughput, which is what "tps" means to
  a user.

Honesty note (surfaced in README, not the UI): this is per-API-call average
throughput sampled at ~1Hz, including inter-call gaps within the EMA window.
It is not stream-decode TPS. True decode TPS would require core transport
changes to expose per-chunk deltas; rejected as out of scope (10x the cost
for marginal value).

### Rendering: the footer-tail seam (one small, additive core change)

Research found the existing `setDecorationSuffix` seam appends to the first
footer line (the quota line) but has two fatal limitations for this feature:

1. **Single-writer singleton**: `ma-diagnostics-plugin` already publishes its
   LSP badge there. Two plugins writing the suffix clobber each other.
2. **No right-alignment**: the suffix publisher cannot know the line's
   visible width (the suffix is applied AFTER the line is built), so it can
   never push content to the terminal's right edge.

Fix (additive, no behavior change for existing plugins):

- `plugin-api/src/utils/footer-tail.ts`: keyed tail registry.
  `setFooterTail(key, text)` / `getFooterTails(): string` (joins non-empty
  values with a two-space gap). Host-owned storage pattern identical to
  `decoration-suffix.ts`.
- `LiveAreaHandlerContext` gains `setFooterTail?: (text: string) => void`.
  The scheduler binds it per-slot with the slot's plugin id as the registry
  key, so concurrent plugin writers never collide.
- `LiveAreaScheduler.flushFooter`: after building `footer[0]`, compute its
  visible width via the existing `displayWidth(stripAnsi(...))` utils,
  resolve `cols` (COLUMNS env / stdout.columns, same rule as quota-status),
  and pad so the joined tail block ends at the right edge. When `cols` is
  unknown or the pad would be < 2, fall back to a two-space inline gap.
  Legacy `decorationSuffix` behavior is untouched (diagnostics keeps its
  inline badge).

The TPS handler publishes `N/tps` (faint) through `ctx.setFooterTail` and
clears it with `""` when idle. The slot itself ALWAYS returns `null`
(suffix-only visual, same pattern as `lsp-status-slot.ts`) with an empty
placeholder so no extra row is reserved. Returning the string from the
handler AND publishing the suffix would double-render (own row + suffix on
footer[0]); a unit test pins the always-null contract.

### Known limitation: orphaned suffix without a companion footer plugin

`flushFooter` drops the tails when there are no other footer lines
(inline-gap fallback still applies, but with no line there is nothing to
append to). If the user runs this plugin WITHOUT quota-status
or any other footer-producing plugin, TPS renders nowhere, silently.
Accepted and documented: TPS is a companion readout for the quota line by
design (the user's ask was "same line as the quota"), and manufacturing a
solo row would defeat the same-line requirement. The README states the
requirement. A future core enhancement could let tails force a minimal
footer row; out of scope.

- Idle: handler publishes "" to clear the tail; the row collapses to
  just the quota line.

### Refresh wiring

manifest.json:

```json
{
  "id": "tps",
  "name": "TPS",
  "version": "0.1.0",
  "description": "Real-time tokens-per-second readout, right-aligned on the quota footer line.",
  "capabilities": ["session-info:read"],
  "liveAreaSlots": [{
    "id": "tps",
    "handler": { "type": "module", "path": "./handler.ts", "export": "default" },
    "position": "footer",
    "refreshMs": 1000,
    "timeoutMs": 800,
    "placeholder": "",
    "refreshOn": ["quota.headersReceived"]
  }]
}
```

`capabilities` is the load-bearing field: the capability host is
deny-by-default (populated namespaces match the grants exactly), so a
missing `session-info:read` grant means `ctx.host.sessionInfo` is undefined
and the handler silently returns null forever. `permissions` is a DIFFERENT
field (it gates hook channels); this plugin declares no hooks so it needs
no permissions.

No `permissions` needed: the permissions array gates hook channels only
(loader.ts:674); host capability slices are gated by `capabilities`. Empty
placeholder is intentional: the slot returns null always (suffix-only
visual), so no row is reserved and no jump occurs — the placeholder-jump
warning in plugin.ts:942 applies only to slots that paint their own row.

Sampling timestamps use `performance.now()` (monotonic), not `Date.now()`,
so NTP/clock adjustments can't drop samples or skew dt.

The 1s timer gives steady-state sampling; the bus event gives immediate
samples at each API-call boundary (finer granularity during fast agentic
loops). Scheduler enforces min refreshMs 1000 and skips fires while
in-flight, so bursts collapse safely.

### Decoupling guarantees

- No imports from core `src/` — only structural type mirrors in
  `host-types.ts` (the Wave-D contract used by quota-status and
  diagnostics).
- Deny-by-default capability narrowing: if `session-info:read` isn't
  granted, handler returns null forever, no crash.
- Pure functions (`tps-tracker.ts`, `render.ts`) fully unit-testable with
  injected clocks; no I/O, no env reads.
