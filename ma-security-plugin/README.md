# security (skeleton)

Secret redaction and tool guard plugin for minimal-agent. This is the
skeleton phase: every hook passes its payload through unchanged.

- `message.willSend`: redact send (stub)
- `tool.willInvoke`: guard invoke (stub, allows all)
- `turn.willStart`: config notices (stub)
- `tool.didBatch`: escalation halt (stub)
- `SecurityStatus` tool and `/security` command: report `{"profile":"steer","phase":"skeleton"}`

Design rules enforced by `src/arch.test.ts` and `src/deps.test.ts`:

- Every hook handler is synchronous. Its body is one top-level try/catch.
- No hook declares `timeoutMs`.
- The plugin never prints to the console.
- Zero runtime dependencies. Imports are relative, `node:*`, or `bun`.

**Disabled by default** (`manifest.enabled: false`). Enable for one run:

```bash
bun run start -- --enable-plugin security
```

Copyright Gaston Morixe. All rights reserved.
