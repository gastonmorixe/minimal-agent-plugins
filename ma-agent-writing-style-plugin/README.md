# ma-agent-writing-style-plugin

Opinionated agent writing style for minimal-agent. Pure prompt plugin. No tools, no inline tags, no live area.

Injects `PROMPT.md` into the system prompt at session start. The model reads it and applies the rules to every reply, every commit message, every doc edit, every comment, every README it touches.

## What it kills

- Em-dashes. Hard ban. The single most identifiable AI tell.
- Semicolons. Almost-ban. Think ten times, then write a period or a comma.
- Curly quotes. Use straight `"` and `'`.
- Mechanical boldface. Bold only what a careful editor would.
- AI dictionary: _delve, tapestry, landscape_ (figurative), _leverage, harness, navigate_ (figurative), _streamline, resonate, synergy, paradigm shift, groundbreaking, transformative, testament, pivotal, robust, seamless, vibrant, intricate, fostering, garner, underscore, showcase, exemplify, boast, align with, crucial, comprehensive, nuanced_, and the rest of the tier-1 and tier-2 list in PROMPT.md.
- Copula avoidance. Write _is_ and _has_, not _serves as_ and _boasts_.
- Superficial -ing tails ("...highlighting the importance of").
- "Not just X, but Y" as a structural crutch.
- Sycophancy ("Great question!", "I hope this helps!").
- Signposting ("Let's dive in", "Here's what you need to know").
- Significance inflation ("pivotal moment", "evolving landscape").
- Vague attribution ("experts argue").
- Emoji as formatting (✨ ✅ 👉) unless the user used emoji first.
- Inline-header lists (`- **Header:** description`) unless the user asked.

## What it asks for

- Plain words. _Use, change, big, new, has, is, show._
- Varied sentence length. Throw in fragments. Start with "But", "And", "So".
- A position. An opinion. One rough edge.
- A read-it-aloud test before sending.

## Install

Symlink into the home plugin root:

```bash
ln -sfn "$PWD/ma-agent-writing-style-plugin" ~/.agents/plugins/ma-agent-writing-style-plugin
```

minimal-agent picks it up on next launch. To disable, either remove the symlink or set `plugins["ma-agent-writing-style"].enabled = false` in `~/.minimal-agent/config.jsonc`.

## Layout

```
ma-agent-writing-style-plugin/
├── manifest.json    # plugin metadata, points to PROMPT.md
├── PROMPT.md        # the rules, composed into the system prompt
└── README.md        # this file
```

This is a **prompt-only plugin**: its single contribution is the
`PROMPT.md` body, declared via the manifest's top-level `prompt` field.
No tools, no tags, no fragments. minimal-agent's loader infers the prompt
role from the manifest shape, and a plugin with only a `prompt` (no
`tuis`/`modes`/`emit` tags) composes as a `<ma::sys::behavior>` mandate:
a first-class instruction in the system prompt, not documentation about a
plugin. (Earlier versions shipped a no-op `lib/prompt-fragment.ts` stub to
satisfy a now-removed validator gate; it is no longer needed.)

## Why

LLM writing has a fingerprint. Em-dashes injecting dramatic asides, "not just X, but Y" parallelisms, "the system serves as a foundation for innovation", "delve into the intricate tapestry", "Despite its challenges, the project continues to thrive". The patterns are now well-documented across peer-reviewed studies (Kobak et al. 2025 in _Science Advances_, Reinhart et al. 2025 in _PNAS_, Juzek and Ward 2025 at ACL) and big-corpus journalism (Washington Post analyzed 328,744 ChatGPT messages in November 2025).

This plugin codifies the suppression rules as a system-prompt fragment so every session inherits them.

## Sources behind the rules

- [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), maintained by WikiProject AI Cleanup. The canonical field guide.
- [`jpeggdev/humanize-writing`](https://github.com/jpeggdev/humanize-writing). 8-pass editing workflow, full vocab list.
- [`blader/humanizer`](https://github.com/blader/humanizer). 24-pattern catalog derived from Wikipedia.
- Kobak et al., "Delving into LLM-assisted writing in biomedical publications through excess vocabulary", _Science Advances_, July 2025.
- Reinhart et al., "Do LLMs write like humans? Variation in grammatical and rhetorical styles", _PNAS_, February 2025.
- Juzek and Ward, "Why Does ChatGPT 'Delve' So Much?", ACL 2025.
- Merrill, Chen, Kumer, "What are the clues that ChatGPT wrote something? We analyzed its style", _Washington Post_, November 2025.

## License

Copyright (c) 2025–2026 Gaston Morixe. All rights reserved.

Proprietary. See the repository [LICENSE](../LICENSE).
