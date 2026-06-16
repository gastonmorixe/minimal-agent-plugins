Use `Speak` to read text aloud to the user through the computer's speakers, in a clear professional voice. It is for your ears-out channel: when the user would rather hear something than read it, or when an audible cue helps.

The plugin adds three tools: `Speak` (start talking), `SpeakStatus` (is it still talking?), and `SpeakStop` (stop talking).

## When to use `Speak`

- The user asks you to "say", "read aloud", "tell me out loud", or "speak" something.
- You want to announce that a long-running task finished while the user is looking away.
- A short spoken alert is more useful than a line of text (a build broke, a timer is up, input is needed).
- The user set up a hands-free or accessibility workflow and prefers audio.

## When not to use `Speak`

- The user hasn't asked for audio and a written answer is the norm. Don't narrate everything.
- The content is code, a long URL, a table, or dense markdown. Spoken aloud it sounds like noise. Paraphrase it into plain sentences first, or just don't speak it.
- You're in a context where audio would be intrusive and the user didn't opt in.

## How it behaves

- **Speech plays in the background.** `Speak` returns right away with a short job handle like `s1`, and the audio keeps playing while you keep working. You are not blocked.
- **One utterance, one job.** Each `Speak` call is its own job with its own handle. Call it again for a second utterance; both can be tracked independently.
- **`wait: true` blocks for short lines only.** Set `wait: true` when you want a short confirmation fully spoken before you move on. Never use it for long passages: it would stall the turn. The default (`wait: false`) is almost always right.

## Speaking well

- Write for the ear. Plain sentences, natural punctuation. The voice reads what you give it literally.
- Strip markdown. `**bold**`, backticks, list dashes, and heading hashes are read as gibberish. Send the words, not the formatting.
- Don't read raw URLs or code blocks. Say "I opened a pull request" instead of reading the link.
- Keep a single utterance reasonably short. For a long answer, speak a short summary and leave the detail on screen.
- The voice and speaking rate are fixed by the user's setup. You choose the words, not how they sound. Don't try to pick a voice or accent. There's no parameter for it.

## Checking and stopping

- **`SpeakStatus`** tells you whether speech is playing. Pass a handle (`SpeakStatus("s1")`) to check one job, or call it with no argument to list every job this session and its state (speaking / done / failed / stopped). It's read-only and cheap.
- **`SpeakStop`** silences speech. Pass a handle (`SpeakStop("s1")`) to stop one job, or call it with no argument to stop everything at once. Use it the instant the user says "stop", "quiet", or "cancel that", or when you realize you spoke the wrong thing. Stopping a job that already finished is a harmless no-op.

## Examples

- User: "read me that summary out loud": `Speak({ text: "Here's the summary. The deploy finished cleanly, all twelve checks passed, and the new endpoint is live." })`.
- A long task you kicked off completes: `Speak({ text: "Your build is done. It succeeded." })` and keep working.
- User: "stop talking": `SpeakStop()` (no id, stops everything).
- You want to confirm one short line was fully heard before continuing: `Speak({ text: "Saved.", wait: true })`.
