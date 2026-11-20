# ma-hooks-plugin (`hooks`)

Config-driven hooks for minimal-agent. Shell and HTTP hooks run on HookBus
channels with no TypeScript. On by default. Opt out with
`--disable-plugin hooks` or `plugins.hooks.enabled: false`.

## Sources (native, always first)

1. `~/.minimal-agent/hooks.json`
2. `<project>/.minimal-agent/hooks.json`
3. `<project>/.minimal-agent/hooks.local.json`

```json
{
  "hooks": {
    "tool.willInvoke": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "./guard.sh", "timeout": 10 }]
      }
    ]
  },
  "disableAllHooks": false,
  "disable": ["claude:user:PreToolUse:3f9a01c2"]
}
```

## Protocol

Stdin: `{ channel, payload, sid, cwd, projectDir, mode, agentId?, leadSid? }`.
Env: `MA_PROJECT_DIR`, `MA_SESSION_ID`, `MA_CHANNEL` (plus `MA_PLUGIN_ROOT`,
`MA_PLUGIN_DATA` for plugin hooks).

A command hook inherits the full agent environment (only `BUN_BE_BUN` is
removed). That includes provider API keys and `MA_TRUST_HOOKS`. Trust a hook
only when you trust it with those values.

Payload rewrites: only some keys may change, per channel
(`engine/channels.ts` `REWRITABLE_KEYS`). `tool.willInvoke` takes `input`,
`turn.willStart` takes `text`. Every other channel is context only. Other keys
(`sid`, `agentId`, `cwd`, `tool`, ...) are ignored with one log line. Only the
rewrite of a hook with the winning decision applies (deny over ask over
allow), and native wins a tie.

Exit 0 with JSON: `{ decision, reason?, payload?, context?, continue?, message? }`.
Exit 0 with text: context on `turn.willStart` and `session.willStart`.
Exit 2: deny with stderr as the reason (context on feedback-only channels).
Any other exit: a non-blocking error, unless `failClosed: true`.

## Context position

A native hook can put its context before or after the user's text. Set
`"position": "before"` or `"position": "after"` on the handler. The default
is `after`. Any other value logs a config warning and uses `after`.

```json
{
  "hooks": {
    "turn.willStart": [{ "hooks": [{ "command": "cat ~/notes/rules.md", "position": "before" }] }]
  }
}
```

A top-level `position` in the JSON output overrides the config for that
result. Plain-text stdout uses the config position. A bad output value is
ignored (debug log), and the config position applies.

```json
{ "context": ["Branch main is frozen."], "position": "before" }
```

Position matters on `turn.willStart` and `session.willStart` only. There the
plugin sends each `before` entry to the HookBus as an object
`{ text, position: "before" }`, first, and each `after` entry as a plain
string (a plain string means `after` on every channel). Inside each position
the order stays: native first, then source order. Other channels get plain
strings only. Claude hooks are always `after`: a `position` key in Claude
config is ignored and logged at debug. The trust hash covers only the config
position: a config `before` is part of the hash, so a change to `before`
needs a new trust, and an explicit `after` hashes the same as no position. A
hook's JSON output may still choose `before` at run time; the spec allows
this, and it does not change the hash. `/hooks list` shows
`position before` in the matcher line, and shows nothing for `after`.

## Trust

User hooks run. Project and plugin hooks (native and Claude
`.claude/settings*.json`) run only when the project is trusted and the hook
hash is trusted in `~/.minimal-agent/hooks-state.json`.

1. Trust a hook with `/hooks trust <key>` (see "The /hooks command"). To
   trust all hooks for one run, start with `--trust-hooks` (the CLI sets
   `MA_TRUST_HOOKS=1`) or `MA_TRUST_HOOKS=1`.
2. When untrusted hooks are skipped, the plugin shows one notice per session
   (`notification.emit`). It names each hook (trust key, dialect, channel,
   source file, a short command preview) and names `/hooks trust <key>`,
   `/hooks trust-all <file>`, `--trust-hooks` and `MA_TRUST_HOOKS=1`. A hook that is new or
   changed later in the session gives one more notice.
3. The trust hash (`engine/hash.ts`) covers the normalized dialect, channel,
   dialect event, matcher, the Claude `if` filter, and the handler: type,
   command and args (or url, headers and allowed env vars), shell, env,
   timeout, `async`, `failClosed` (Claude `onFailure`), and a `before`
   context position. Key order and
   default values do not change it. A change to any of these makes a trusted
   hook untrusted again. The hash does not cover the script file: an edit to
   a script that a trusted command names runs with no new review.
4. `disableAllHooks` and `disable` from a project or plugin source apply only
   when the project is trusted, and then only to project and plugin hooks. A
   project can never turn off a user hook.

## The /hooks command

1. `/hooks` or `/hooks list`: every parsed hook, grouped by channel
   (unsupported events last). Each row: trust key, dialect, event, matcher
   and Claude `if`, a command preview, source file and scope, trust state
   (`trusted`, `untrusted`, `untrusted-hash`, `implicit-user`, `env`),
   enabled state (`enabled`, `disabled`, `disabled-by-config`, `shadowed` by
   a dedup), support state (`supported`, `unsupported-type`,
   `unsupported-event`), and the last result with its time. Last results are
   kept in memory only (256 hooks per engine), so they reset on restart.
2. `/hooks trust <key>` trusts the project and the hook's current hash. The
   output says so: the project's `disableAllHooks` and `disable` switches
   apply from then on. `/hooks untrust <key>` forgets the hash.
3. `/hooks enable <key>` and `/hooks disable <key>` set the enabled flag in
   the state file. A disabled hook never runs, also not with `MA_TRUST_HOOKS=1`.
4. `/hooks trust-all <file>` trusts every hook of one source file. The path
   is absolute or relative to the project root, for example
   `/hooks trust-all .claude/settings.json`.
5. An unknown key or file gives an error message. Writes are atomic. The
   state file is part of the reload check, so every engine sees a change at
   its next dispatch.

## Trust keys

A key is `<dialect>:<source id>:<event>:<8 hex>`, for example
`native:project:tool.willInvoke:1c0e5a7b`. The hex is a hash of the matcher,
the Claude `if` filter, and the command plus args (or url). It does not use
the position in the file, so inserting a hook before another keeps the other
key and its trust and enabled records. A second hook with the same identity
in one file gets `-2` (then `-3`). A tuning edit (timeout, shell, env, async,
failClosed) keeps the key but changes the content hash, so the hook needs
re-trust. Changing the matcher or command gives a new key.

Migration: keys used to be positional (`...:0:0`). Records in an old
`hooks-state.json` and old `disable` entries no longer match. Re-trust once
with `/hooks trust <key>` or `/hooks trust-all <file>`, and update `disable`
lists with the keys that `/hooks` shows.

## Process cleanup

Each command hook runs in its own process group. The runner tracks the live
groups and sends SIGKILL to them on host `exit`, `SIGINT`, `SIGTERM` and
`SIGHUP` (a closed terminal), so a hook grandchild does not outlive the agent.
The listeners are added once. Each signal listener carries the shared fan-out
tag `Symbol.for("minimal-agent.signal-fanout")`, the same tag as ma-background
and ma-speak. Fan-out listeners never count as owners of the signal. If the
host has its own untagged listener, the host keeps control. If only fan-out
listeners exist, each one removes itself and raises the signal again, so the
default action still ends the process. It never calls
`process.exit`. The core file-lock signal listener also carries the fan-out
tag. When it is the last listener, it removes its locks and calls
`process.exit` (130 for SIGINT, 143 for SIGTERM), not the default action. Core has a child registry (`src/infra/child-registry.ts`),
but the plugin API does not export it and it covers `exit` only.

## Disable scope

A switch turns off hooks of its own scope or lower, never higher:

1. A user-scope `disableAllHooks` (native) turns off every hook. A user-scope
   Claude `disableAllHooks` turns off every Claude hook.
2. A project-scope `disableAllHooks` or `disable` list (native or Claude
   `.claude/settings*.json`) turns off only project-scope (and plugin) hooks.
3. A project-scope switch works only when the project is trusted (or
   `MA_TRUST_HOOKS=1`). An untrusted project switch is ignored with a warning.
4. A project `disable` list cannot target a user hook. A user-scope key in it
   is ignored. Use `/hooks disable <key>` or a user-scope list instead.

## Dedup

Identical hooks (handler, args, shell, env, timeout, channel, matcher,
`async`, `failClosed`) run once. Dedup runs only over hooks that pass the
trust, enabled and disable filters, so an untrusted copy never shadows a
runnable one. A user-scope copy wins over a project-scope copy. In one scope
the earliest source wins, so native beats Claude. Plugin copies stay separate.

## Stop and session start

1. `turn.willStop` (Claude `Stop` and `SubagentStop`): a deny or
   `decision: "block"` halts with the reason, and the core loop continues the
   turn. The next call has `stopHookActive: true` (Claude `stop_hook_active`).
2. `session.willStart` (Claude `SessionStart`): context only. A deny or exit 2
   never blocks.
3. Claude stdin carries `transcript_path`: `<agent home>/sessions/<sid>.jsonl`
   (default `~/.minimal-agent/sessions/<sid>.jsonl`).

## Open items

1. `stopBlockCap` passthrough: the plugin cannot set the core cap yet, so the
   core default (8) is used.
2. Ask prompt: there is no host prompt, so `ask` and `defer` become deny.
3. Plugin `hooks/hooks.json` enumeration and Claude plugin hook discovery.
4. Claude `PermissionRequest`.
5. `CLAUDE_ENV_FILE`.
6. HTTP handler tests.
7. `hooks-output` file permissions and prune.
8. Review nits that are still open.
9. `hooks-state.json` prune: entries of removed projects and hooks stay.
10. No cross-process lock on `hooks-state.json`. Each write re-reads the file,
    but two writes at the same time: the last writer wins.
11. `MA_TRUST_HOOKS=1` is inherited by hook children and sub-agents.
12. A `SIGINT` that only cancels a turn (the host owns it) also kills the
    async hooks that run at that time.

## Layout

`engine/` canonical model, runner, merge, trust, async queue, output cap,
adapter registry (`engine/registry.ts`). `native/` the native dialect.
`adapters/<id>/` other dialects (Claude next). Spec:
`research/2026-11-15-hooks-plugin-adapters/SPEC.md` in the monorepo.

`engine/import-boundary.test.ts` enforces the dependency rule: an adapter
imports only the engine, `native/` never imports `adapters/`, and only
`engine/registry.ts` imports a dialect.
