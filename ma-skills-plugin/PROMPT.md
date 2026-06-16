Use `Skill` to discover and load [Agent Skills][as]: on-demand packs of procedural knowledge. A skill is a folder with a `SKILL.md` (YAML frontmatter + markdown body) plus optional `scripts/`, `references/`, and `assets/`, encoding things like how to cut a release, fill a PDF form, or run a code review. You load one only when a task needs it, instead of carrying every workflow in the prompt.

[as]: https://agentskills.io

## How discovery works

At session start these roots are scanned in precedence order (closer-to-user wins) to build a **Level 1** catalog (name + description + scope + path). The body of each `SKILL.md` is not inlined. That's Level 2, loaded on demand.

1. `<cwd>/.agents/skills/` (project, highest precedence)
2. `<cwd>/.claude/skills/` (project, Claude Code interop, opt-in)
3. `~/.agents/skills/` (home, shared with other agents)
4. `~/.minimal-agent/skills/` (user, agent-specific)

If two roots define a skill with the same `name`, the higher-precedence one wins. The shadowed one is listed under "Shadowed" in the catalog.

The catalog (shown below in this section, under `## Skills available this session`) is the source of truth for what's available. Read it before deciding to invoke a skill.

## When to use a skill

- The user's task matches one of the catalog entries' descriptions.
- You'd otherwise re-derive procedural knowledge a skill already encodes.
- You need a deterministic, repeatable workflow rather than ad-hoc steps.

## When not to use a skill

- The task is trivial or one-off. Don't activate a skill for a single shell command.
- The catalog has no matching skill. Say so plainly, don't force a fit.
- You've already loaded the relevant skill earlier in this conversation. The body is in context, no need to re-load.

## The `Skill` tool

Three actions, all addressed by skill `name` (not directory path):

```
Skill {action: "list"}                       # enumerate everything
Skill {action: "info", name: "<name>"}       # show one skill's frontmatter
Skill {action: "read", name: "<name>"}       # load full SKILL.md body
```

- **`list`** returns a JSON catalog plus broken/shadowed diagnostics. Use it when you're unsure what's available or when the user asks "what skills do I have?".
- **`info`** is cheap. Pure metadata, no body load. Use it to verify scope/license/compatibility before activating.
- **`read`** is how you **activate** a skill. The tool returns the full SKILL.md body plus a trailer listing bundled sibling files (`scripts/`, `references/`, etc.) you can `Read` next, and any `allowed-tools` field for self-enforcement (see below).

You can also `Read` the SKILL.md path directly. Both paths work. The `Skill` tool is preferred because the name lookup is structured (no path typos) and the trailer gives you the sibling listing for free.

## After you've loaded a skill

1. **Follow the body's instructions step by step.** Skills are written like onboarding docs, sequential, with the right level of detail for an agent.
2. **Read referenced files via `Read`.** When the body says "see `references/FORMS.md`" or "use the schema in `assets/`", `Read` that exact path. The trailer shows you which siblings exist.
3. **Execute bundled scripts via `Bash`.** When the body says "run `scripts/extract.py`", `Bash` it. Script source never enters context, only its stdout.
4. **Cite the skill in your reply.** Tell the user which skill you activated. It grounds your work in an inspectable artifact.

## `allowed-tools` self-enforcement

The spec's `allowed-tools` field (experimental) is a space-separated list like `Bash(git:*) Bash(jq:*) Read`. When a skill declares it, the `Skill read` result reminds you of the constraint:

> *Self-enforce `allowed-tools`: Bash(git:*) Read*

You're on the hook to respect it. minimal-agent does not block tools at the dispatcher layer yet. Treat the field as a soft contract from the skill author saying "these tools are sufficient and intended, and staying within this set keeps the workflow auditable."

## Don't

- **Don't paraphrase a skill from its description alone.** The Level 1 catalog is a router, not the content. Call `Skill read` first.
- **Don't activate every skill that vaguely matches.** Pick the most specific one. If two seem equally relevant, ask the user.
- **Don't trust skills from untrusted sources without auditing.** Skills are code + prompts that direct your behavior. Treat third-party skills like installing software: read the SKILL.md, scan the `scripts/`, then decide.
- **Don't store secrets inside SKILL.md or assets.** They get loaded into context wholesale on `Skill read`.

## Output

- `Skill list` content = JSON (model-readable), display = ANSI table.
- `Skill info` content = canonical YAML-ish dump, display = compact key/value block.
- `Skill read` content = SKILL.md body + sibling trailer + allowed-tools hint, display = first ~14 lines clipped at 240 columns. The full body is in `content`. The agent's universal output guardrail will clamp pathological `SKILL.md` files cleanly (`_truncCtx` is wired).
