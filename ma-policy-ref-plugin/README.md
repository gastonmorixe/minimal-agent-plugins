# policy-ref (reference lifecycle policy)

Fixture plugin that proves the LifecyclePort / HookBus seams:

- **`tool.willInvoke`** — deny Bash `rm -rf /`
- **`message.willSend`** — redact `sk-…` tokens before network send

**Disabled by default** (`manifest.enabled: false`). Enable for a run:

```bash
bun run start -- --enable-plugin policy-ref
```

Not intended as production security policy — use it to verify deny/rewrite wiring.
