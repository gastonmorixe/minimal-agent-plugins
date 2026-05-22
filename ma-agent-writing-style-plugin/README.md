# ma-agent-writing-style-plugin

Opinionated agent writing style for minimal-agent. Pure prompt plugin. No tools, no inline tags, no live area.

Injects `PROMPT.md` into the system prompt at session start. The model reads it and applies the rules to every reply, every commit message, every doc edit, every comment, every README it touches.

## What it kills

- Em-dashes. Hard ban. The single most identifiable AI tell.
- Semicolons. Almost-ban. Think ten times, then write a period or a comma.
- Curly quotes. Use straight `"` and `'`.
- Mechanical boldface. Bold only what a careful editor would.
- AI dictionary: *delve, tapestry, landscape* (figurative), *leverage, harness, navigate* (figurative), *streamline, resonate, synergy, paradigm shift, groundbreaking, transformative, testament, pivotal, robust, seamless, vibrant, intricate, fostering, garner, underscore, showcase, exemplify, boast, align with, crucial, comprehensive, nuanced*, and the rest of the tier-1 and tier-2 list in PROMPT.md.
- Copula avoidance. Write *is* and *has*, not *serves as* and *boasts*.
- Superficial -ing tails ("...highlighting the importance of").
- "Not just X, but Y" as a structural crutch.
- Sycophancy ("Great question!", "I hope this helps!").
- Signposting ("Let's dive in", "Here's what you need to know").
- Significance inflation ("pivotal moment", "evolving landscape").
- Vague attribution ("experts argue").
- Emoji as formatting (✨ ✅ 👉) unless the user used emoji first.
- Inline-header lists (`- **Header:** description`) unless the user asked.

## What it asks for

- Plain words. *Use, change, big, new, has, is, show.*
- Varied sentence length. Throw in fragments. Start with "But", "And", "So".
- A position. An opinion. One rough edge.
- A read-it-aloud test before sending.

## Install

Symlink into the home plugin root:

```bash
ln -s ~/Projects/minimal-agent-plugins/ma-agent-writing-style-plugin ~/.agents/tui-plugins/ma-agent-writing-style-plugin
```

minimal-agent picks it up on next launch. To disable, either remove the symlink or set `plugins["ma-agent-writing-style"].enabled = false` in `~/.minimal-agent/config.jsonc`.

## Layout

```
ma-agent-writing-style-plugin/
├── manifest.json    # plugin metadata, points to PROMPT.md
├── PROMPT.md        # the rules, injected into the system prompt
├── lib/
│   └── prompt-fragment.ts   # no-op stub, see below
└── README.md        # this file
```

### Why the no-op `lib/prompt-fragment.ts`

minimal-agent's manifest validator historically required at least one of
`tuis`, `modes`, `events`, `hooks`, `promptFragments`, or `liveAreaSlots`
on every plugin. A non-empty top-level `prompt` field was NOT counted as a
valid contribution by that gate, even though it works fine.

The validator was relaxed in May 2026 to count `prompt` as a contribution
(see `src/plugins/manifest.ts` `parseManifest` and the matching tests).
After that fix lands in the version of minimal-agent you are running, you
can delete `lib/` and remove the `promptFragments` entry from
`manifest.json`. Until then, this stub keeps the plugin loadable.

## Why

LLM writing has a fingerprint. Em-dashes injecting dramatic asides, "not just X, but Y" parallelisms, "the system serves as a foundation for innovation", "delve into the intricate tapestry", "Despite its challenges, the project continues to thrive". The patterns are now well-documented across peer-reviewed studies (Kobak et al. 2025 in *Science Advances*, Reinhart et al. 2025 in *PNAS*, Juzek and Ward 2025 at ACL) and big-corpus journalism (Washington Post analyzed 328,744 ChatGPT messages in November 2025).

This plugin codifies the suppression rules as a system-prompt fragment so every session inherits them.

## Sources behind the rules

- [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), maintained by WikiProject AI Cleanup. The canonical field guide.
- [`jpeggdev/humanize-writing`](https://github.com/jpeggdev/humanize-writing). 8-pass editing workflow, full vocab list.
- [`blader/humanizer`](https://github.com/blader/humanizer). 24-pattern catalog derived from Wikipedia.
- Kobak et al., "Delving into LLM-assisted writing in biomedical publications through excess vocabulary", *Science Advances*, July 2025.
- Reinhart et al., "Do LLMs write like humans? Variation in grammatical and rhetorical styles", *PNAS*, February 2025.
- Juzek and Ward, "Why Does ChatGPT 'Delve' So Much?", ACL 2025.
- Merrill, Chen, Kumer, "What are the clues that ChatGPT wrote something? We analyzed its style", *Washington Post*, November 2025.

## License

MIT.
