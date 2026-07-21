# ma-intercom-plugin

Inter-session communication and presence for minimal-agent. Lets any session see
what other sessions are doing and message them, peer-to-peer, across independent
top-level REPLs and projects on the same machine.

Tools: **`Peers`** (roster + cross-plugin inspection), **`Send`** (note / ping /
interrupt / broadcast), **`Inbox`** (re-read received messages). Plus an ambient
footer (`⇆ intercom · N online`), automatic per-turn delivery of received
messages as a `<ma::agent::intercom-inbox>` block, and **`@`-mention** peer
autocomplete in the prompt (live highlight + dual representation for the model).

## How it works

No daemon, no sockets. Everything is small files under the agent home, which the
host hands the plugin via `MINIMAL_AGENT_HOME` (see "Storage path" below):

```
<home>/intercom/
  presence/<sid>.json   one record per session, rewritten each heartbeat (atomic)
  inbox/<sid>.jsonl     per-RECIPIENT append-only message queue
  inbox/<sid>.jsonl.appendlock   short exclusive lock during large appends
  cursors/<sid>.json    recipient-owned high-water marks {seen, woken, read}
  self/<sid>.json       this session's own activity label (internal)
```

### Presence + liveness (derived, never trusted)

A session publishes a presence record every 5s (a live-area heartbeat slot)
carrying its pid + a timestamp. Readers **derive** liveness from heartbeat
freshness plus a `kill(pid,0)` probe — a session never self-declares "alive" or
"dead". So a session that dies uncleanly (crash, SIGKILL, a never-fired exit
hook) is still reported correctly: it stops beating, its age crosses the
thresholds, and the pid probe confirms it's gone.

| heartbeat age | pid (same host) | verdict |
|---|---|---|
| ≤ fresh (20s) | — | `online` (+ self phase: active/idle/busy) |
| fresh..stale (20–90s) | alive | `online` (slow beat) |
| fresh..stale | gone | `dead` |
| fresh..stale | cross-host (no probe) | `stale` |
| > stale (90s) | alive | `hung` |
| > stale | gone | `dead` |
| > stale | cross-host | `offline` |

Thresholds are env-tunable (`MINIMAL_AGENT_INTERCOM_FRESH_MS`, `_STALE_MS`,
`_HEARTBEAT_MS`). The busy/idle phase is derived from the session transcript's
modification time, so it's correct across resume and needs no turn-lifecycle
events.

### Delivery (two channels, each for its strength)

- **Content** rides the `turnAttachments` port: a producer renders inbox
  messages past the `seen` cursor as a `<ma::agent::intercom-inbox>` block on the
  first user message each turn (cache-friendly, zero cost when empty, replay-safe
  via the core `<ma::agent::*>` scrubber). Each message is shown exactly once;
  the model dedups on envelope `id` for the at-least-once replay window.
- **Wake** rides `prompt.inject`: the heartbeat slot, on seeing a new
  `ping`/`interrupt` past the `woken` cursor, injects one nudge so an idle REPL
  wakes between turns (never mid-response). `note` messages never wake.

### Message size

Bodies are clamped only at a high **safety ceiling** (`MAX_BODY_LEN` =
256_000 chars in `lib/envelope.ts`) so a runaway model cannot flood peers with
multi-megabyte dumps. Normal plans/reviews fit with room to spare. Concurrent
inbox appends use a short exclusive sibling lock (`.appendlock`) so large JSONL
lines stay whole-line atomic without relying on `PIPE_BUF` (the old ~3.5k
limit). Reader-side sanitization clips at the same ceiling so a delivered body
is never re-truncated on render.

### Inter-plugin inspection

`Peers inspect` aggregates a peer's state from other plugins' per-session
sidecars — `<sid>.tasks.jsonl` (tasks), `<sid>.bgjobs.jsonl` (background jobs),
`<sid>.subagents.jsonl` (fleet) — with tolerant local parsers, plus the host
`sessions:read` capability for activity + a transcript excerpt. It imports none
of those plugins; the shared `sessions/` file layout is the contract.

### `@`-mention peer autocomplete

Type `@` in the prompt (mid-line is fine) to mention another registered session
by **display name** or **sid** (short or full). The UX mirrors the slash-menu:
pure plugin FSM + ANSI render, host owns painting.

```
  ► ● Michelle   online   a1b2c3d4  pid 12345  grok-4.5  minimal-agent-monorepo
    ○ Ronald     idle     b2c3d4e5  pid 23456  …
  ────────────────────────────────────────  ↓ N more
  ↑↓ nav · ⇥ complete · ⏎ select · esc close

❯ hey @Mich
```

| Key | Behavior |
|---|---|
| `↑` / `↓` | Move selection (halted so history does not steal the key) |
| `Tab` | Complete to `@Name ` or `@short ` (trailing space, menu closes) |
| `Enter` | Complete to `@Name` / `@short` **without** halt so submit fires |
| `Esc` | Close menu, keep buffer as typed |

**Live highlight.** While the token matches at least one peer, the whole
`@token` is painted bold violet/purple via the host channel
`editor.buffer.styles` (code-point spans into the buffer string). Unmatched
tokens stay plain.

**Dual representation (TUI vs model).**

| Surface | What you see / what ships |
|---|---|
| Live input, scrollback, queue decoration | Styled `@Michelle` (human form) |
| Model input + conversation history | Wire form from `lib/mention/PROMPTS.ts` |

Wire form example:

```xml
<ma::intercom::peer name="Michelle" sid="a1b2c3d4-e5f6-7890-abcd-ef1234567890">@Michelle</ma::intercom::peer>
```

`name` is omitted when the peer has no display name. Only **uniquely resolved**
tokens are rewritten (exact name, exact short, exact sid, or unique prefix /
top fuzzy score). Ambiguous or unknown `@foo` is left as-is.

**How it is wired (host channels).**

| Channel | Role |
|---|---|
| `editor.buffer.changed` | Open / refilter / close menu; emit style spans |
| `editor.key` (priority **65**, below slash-menu 70) | Nav / Tab / Enter / Esc |
| `editor.footer.set` | Paint the peer list above the prompt (overlay layer) |
| `editor.buffer.styles` | Live `@token` highlight in the input |
| `editor.buffer.set` | Apply completion into the buffer |
| `turn.willStart` (chain) | Rewrite model-facing text just before `agent.run` |

The host emits `turn.willStart` with `{ text }` on queue drain **after**
scrollback commit lines are already captured, so the TUI never shows XML.

**Matching.** Fuzzy subsequence against name, short sid, and full sid. Rows
sort **online-first** (liveness rank), then by match score. Self is excluded
from the menu. `resolvePeer` (tools) also accepts a display name, not only sid.

**Layout (mention-specific).**

```
lib/mention/
  types.ts      PeerCandidate, ScoredPeer, BufferStyleSpan
  fuzzy.ts      subsequence matcher
  overlay.ts    pure FSM (closed | open) + effects
  render.ts     ANSI peer list
  styles.ts     buffer style spans for matching tokens
  rewrite.ts    text → peer XML for unique resolves
  PROMPTS.ts    model-facing XML template (prompt-only module)
  palette.ts    host palette / violet token SGR
  state.ts      process singleton FSM + roster cache
handlers/
  on_key.ts              editor.key
  on_buffer_changed.ts   editor.buffer.changed
  on_turn_will_start.ts  turn.willStart chain
```

## Intercom vs Mailbox

`Mailbox` (sub-agents plugin) is intra-fleet: a lead and the workers it spawned,
scoped to one delegation tree. `Intercom` is peer-to-peer across independent
top-level sessions. Different scope — both exist; the tool names don't collide.

## Storage path (no hardcoded `~/.minimal-agent`)

The plugin never assumes where the agent keeps its data. The host resolves its
real home once at boot and publishes it as `MINIMAL_AGENT_HOME` into the
environment every plugin context inherits (`src/agent-paths.ts:publishAgentHomeEnv`).
`lib/paths.ts` reads that as authoritative; the `homedir()` fallback is only for
running this plugin's unit tests outside a host.

## Config / env

- `MINIMAL_AGENT_INTERCOM_HEARTBEAT_MS` (default 5000)
- `MINIMAL_AGENT_INTERCOM_FRESH_MS` (20000) / `MINIMAL_AGENT_INTERCOM_STALE_MS` (90000)
- `MINIMAL_AGENT_INTERCOM_NO_PRESENCE=1` — don't publish or participate
- `plugins.intercom.enabled=false` in `~/.minimal-agent/config.jsonc` — disable

## Layout

```
lib/        pure core (functional) + thin IO shells
  config, paths, identity, presence, liveness, envelope, inbox, cursors,
  sidecars, roster, render, style, beat, selfstate, service, host-types
  mention/  @-mention FSM, fuzzy, render, rewrite, PROMPTS, styles, state
handlers/   entry points (imperative shells)
  peers, send, inbox, beat (slot), inbox_attachment (turn attachment),
  on_submit (event), on_key / on_buffer_changed / on_turn_will_start (mentions)
manifest.json  tool/slot/attachment/event/hook wiring + capabilities
PROMPT.md      model-facing guidance
```

## Tests

`bun test` from the repo root (or `cd ma-intercom-plugin && bun test`). Covers the
liveness classifier (every band), envelope/inbox/cursor round-trips, tolerant
sidecar parsing, roster merge, the heartbeat (publish + wake), handler smoke
tests, a cross-session integration test that drives two simulated sessions
through a relocated `MINIMAL_AGENT_HOME`, and the mention suite
(`lib/mention/*.test.ts`: fuzzy, overlay FSM, rewrite/PROMPTS, styles,
resolvePeer-by-name).

```sh
cd ma-intercom-plugin
bun test lib/mention    # mention-only, fast
bun run typecheck
```
