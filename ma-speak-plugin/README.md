# ma-speak-plugin

A [minimal-agent][ma] plugin that lets the model read text aloud to the user
through a swappable speech backend. The default backend wraps the macOS
`say` command; the model never learns which engine is behind the tool.

[ma]: https://github.com/gastonmorixe/minimal-agent-core

Three tools:

| Tool | Purpose |
|---|---|
| `Speak` | Start reading text aloud. Returns a job handle (`s1`) immediately; audio plays in the background. |
| `SpeakStatus` | Is speech still playing? Check one job by handle, or list all jobs this session. |
| `SpeakStop` | Stop speech. One job by handle, or every active job at once. |

## Architecture

```
ma-speak-plugin/
├── manifest.json              Plugin manifest (3 tools, schemas, icons)
├── PROMPT.md                  When/how the model should use these tools
├── handlers/
│   ├── speak.ts               Validate → spawn detached → register → return handle
│   ├── speak_status.ts        Read-only status (one job or all)
│   └── speak_stop.ts          Stop one job or all
├── lib/
│   ├── types.ts               Local TUIContext/TUIResult stubs (standalone type-check)
│   ├── jsonc.ts               Tiny JSONC parser (zero-dep config reader)
│   ├── config.ts              Reads plugins["ma-speak"] from ~/.minimal-agent/config.jsonc
│   ├── registry.ts            In-process speech-job registry (module singleton)
│   ├── backend.ts             Backend dispatcher: detached spawn, group-kill, parent-exit hook
│   ├── errors.ts              Backend-agnostic failure taxonomy
│   └── render.ts              ANSI transcript rendering
└── backends/
    └── macos-say.ts           Default backend (wraps `say`, reads text on stdin)
```

### The lifecycle is the inverse of a normal tool

Most tools do their work and return. Speech must **outlive** the tool call: the
audio keeps playing after `Speak` returns. So the handler:

1. Spawns the backend **detached** (its own process group) and feeds the text
   on stdin.
2. Registers the job in an **in-process registry** and returns a short handle
   (`s1`) right away.
3. Wires the backend's eventual exit to a reaper that settles the job
   (`done` / `failed`).

Later `SpeakStatus` / `SpeakStop` calls are **separate tool invocations** that
share the same registry. This works because minimal-agent imports a module
handler once and reuses it for the whole session, so a module-level singleton
persists across calls. No disk, no IPC.

Three protections keep speech from leaking past its welcome:

- **`SpeakStop`** signals the process group (SIGTERM, then SIGKILL after a grace
  period), so the underlying speech CLI dies too, not just the wrapper.
- **Parent-exit hook**: if the agent process exits, an in-flight utterance is
  SIGKILLed. macOS does not propagate parent death to children, so without this
  a long utterance would keep talking to a dead terminal.
- **Job cap**: the registry evicts old terminal jobs so a long session can't
  grow an unbounded heap.

### Backend decoupling

The handler doesn't know `say` exists. It spawns `backends/<config.backend>.ts`
with an `MA_SPEAK_*` env block and feeds the text on stdin. The backend script
is the only place that knows a specific speech CLI. A future
`backends/elevenlabs.ts` honors the same contract and the handler stays
unchanged.

**What the model controls** (tool API): only `text` and `wait`. That's it.

**What the operator controls** (config, never model-facing): the backend, the
binary path, the voice, and the speaking rate. The model picks *what* is said,
never *how* it sounds. That keeps the tool backend-agnostic. By default no voice
is set, so macOS speaks in its high-quality system default (Premium Siri) voice
(see *Leave `voice` unset* below).

### Backend env-var contract

The handler spawns `<plugin>/backends/<backend>.ts` with:

| Var | Required | Notes |
|---|---|---|
| `MA_SPEAK_BIN` | no | Path to the speech binary (default: `say` on PATH). |
| `MA_SPEAK_VOICE` | no | Voice name. macOS backend forwards as `say -v <voice>`. |
| `MA_SPEAK_RATE` | no | Words per minute. macOS backend forwards as `say -r <rate>`. |

Backend I/O contract:
- **stdin** ← the text to speak (UTF-8). Kept off argv so it can be long and
  never shows in `ps`.
- **stdout** → nothing (the "output" is audio).
- **stderr** → diagnostics (never shown raw to the model, see *Failure messages*).
- **exit** → 0 on success, non-zero on failure.

## Install

1. Clone this repo (you probably already did):

   ```bash
   git clone git@github.com:gastonmorixe/minimal-agent-plugins.git ~/minimal-agent-plugins
   ```

2. Symlink the plugin into your minimal-agent home plugin root:

   ```bash
   mkdir -p ~/.agents/plugins
   ln -s ~/minimal-agent-plugins/ma-speak-plugin ~/.agents/plugins/ma-speak-plugin
   ```

3. The default backend needs only macOS's built-in `say` (already on every
   Mac). Start `minimal-agent`; the startup banner should list `Speak`,
   `SpeakStatus`, and `SpeakStop` in the tools row.

4. (Optional) Configure in `~/.minimal-agent/config.jsonc`:

   ```jsonc
   {
     "plugins": {
       "ma-speak": {
         "enabled": true,
         "backend": "macos-say",
         "macos-say": {
           "bin": "/usr/bin/say"    // optional; default is `say` on PATH
           // "voice" is intentionally NOT set here. See the note below.
           // "rate": 180           // optional; words per minute
         },
         "defaults": {
           "maxChars": 8000,        // hard cap on a single utterance
           "waitTimeoutSec": 120    // cap for a blocking `wait: true` call
         }
       }
     }
   }
   ```

### Leave `voice` unset (it sounds better)

By default the plugin passes **no** `-v` to `say`, and that is deliberate. With
no voice flag, `say` uses your **system default voice** (the Premium / Enhanced
Siri voice you pick in System Settings → Accessibility → Spoken Content → System
Voice). Those are the high-quality neural voices.

The named voices from `say -v '?'` are the older, lower-quality ones, and the
Premium Siri voices **cannot be selected by name** on the `say` command line.
So setting `"voice"` actively downgrades the audio. Only set it if you
specifically want a different (lower-fidelity) named voice. To get the best
voice, change your System Voice in System Settings and leave `voice` unset here.

`rate` (words per minute) is independent and safe to set with any voice.

## Failure messages

Every surface the model sees is backend-agnostic. A failed utterance returns a
short, engine-free message:

- "The speech engine is unavailable on this machine." (binary missing / spawn failed)
- "Audio output is unavailable, so the text could not be spoken." (no output device)
- "Speech was stopped before it finished." (stopped / interrupted)
- "The text could not be spoken." (anything unclassified)

Raw `stderr` from the backend never reaches the model. The model only knows it
has a tool that speaks; engine identity lives in operator config and this README.

## Tests

```bash
# All tests
bun test

# A single file
bun test lib/registry.test.ts
```

Tests are colocated with the code they exercise (`foo.ts` ↔ `foo.test.ts`).
Handler and backend tests inject a fake `spawnFn`, so no real `say` is ever
invoked: the suite is fast, offline, and silent (no audio).

## Smoke test the backend in isolation

The macOS backend reads the utterance from stdin. To exercise the wrapper
without blasting audio, point `MA_SPEAK_BIN` at a stand-in:

```bash
printf 'hello from the speak plugin' | \
  MA_SPEAK_BIN=/bin/cat MA_SPEAK_RATE=180 \
  bun backends/macos-say.ts
```

For a real audible test (this will speak out loud, in the system default voice):

```bash
printf 'Hello. This is the speak plugin talking.' | bun backends/macos-say.ts
```

## Adding a new backend

1. Drop `backends/<name>.ts` (executable, `#!/usr/bin/env bun`).
2. Read the utterance from **stdin**, read the `MA_SPEAK_*` env vars, write
   nothing to stdout, send diagnostics to stderr, exit 0 on success.
3. Set `plugins["ma-speak"].backend = "<name>"` in user config (and add a
   `"<name>": { ... }` block for its knobs).

No handler edits, no manifest edits. The model never sees the change.
