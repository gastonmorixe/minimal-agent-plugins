# Lane replay fixtures (lane plan H5)

Six real sub-agent sessions, recorded on 2026-11-18 and scrubbed. The replay
harness (`../../lane/replay-harness.ts`) writes them into a temp sessions
directory, so the plugin code that reads the fleet and the worker files runs
against real worker data.

Each fixture has three files:

| File                   | Source in `~/.minimal-agent/sessions/`                           |
| ---------------------- | ---------------------------------------------------------------- |
| `<name>.stream.ndjson` | `<sid>.stream.ndjson`: the worker's stream-json stdout           |
| `<name>.jsonl`         | `<sid>.jsonl`: the worker's session transcript                   |
| `<name>.fleet.jsonl`   | the worker's last record in `<leadSid>.subagents.jsonl` (1 line) |

## Fixtures

Sizes are in bytes. "Pair" is stream + transcript (the limit is about 150 KB).
No fixture is synthetic, and no fixture was cut at a line: each file has all
the lines of its source. Strings longer than 4000 characters were clipped
in place (`…[clipped N chars]`), and each line is still valid JSON.

| Fixture           | Category                          | Source sid | Type     | Final status | Stream | Transcript | Fleet | Pair   | Lines (stream / transcript) | Clipped strings | Truncated | Synthetic |
| ----------------- | --------------------------------- | ---------- | -------- | ------------ | ------ | ---------- | ----- | ------ | --------------------------- | --------------- | --------- | --------- |
| `quick-explorer`  | a quick explorer                  | `63411e36` | explorer | done         | 28658  | 44950      | 6155  | 73608  | 74 / 35                     | 3               | no        | no        |
| `long-edit-write` | a long worker with Edit and Write | `128890f7` | worker   | done         | 29524  | 42050      | 5029  | 71574  | 90 / 41                     | 4               | no        | no        |
| `failing`         | a failing worker                  | `9437314c` | worker   | failed       | 17808  | 40071      | 4739  | 57879  | 69 / 32                     | 3               | no        | no        |
| `stalled`         | a stalled worker                  | `9ac76df7` | reviewer | stopped      | 6694   | 20422      | 4288  | 27116  | 30 / 15                     | 3               | no        | no        |
| `notice`          | a worker with a notice            | `82c670bf` | reviewer | incomplete   | 39252  | 106264     | 3814  | 145516 | 120 / 52                    | 15              | no        | no        |
| `incomplete`      | a worker that ends incomplete     | `ff332f3e` | worker   | incomplete   | 19900  | 33148      | 5584  | 53048  | 60 / 28                     | 2               | no        | no        |

Notes on each category:

- `quick-explorer`: 12 tools in about 65 s (Bash, Write, ReportResult).
- `long-edit-write`: 18 tools in about 128 s, 6 Edit and 1 Write, a 71 s gap.
- `failing`: the stream ends with `error`, `run_finished` (`failed`) and
  `result`; the fleet error is `HTTP2 ping cancelled`.
- `stalled`: no stream event for about 19 minutes after the last tool; the
  lead stopped it (`No event for 19 minutes (stalled stream)…`). The stream
  has no end line.
- `notice`: the only real notice with a kind other than an old checkpoint
  notice (`refusal`, severity `error`, stream line 117). The other 55 notices in
  the sessions folder are of that old kind with no message, and they all are in
  streams above 130 KB. The worker also ends `incomplete` (a missing
  contracted artifact).
- `incomplete`: the worker called `ReportResult` with `incomplete: true`
  (fleet reason `worker reported it could not finish`). The stream has no
  `result` line.

## Scrub

`../../lane/scrub-fixture.ts` made the files from the real sessions (read
only). It parses each line and scrubs every string and key, so each line stays
valid JSON:

- home paths (the macOS home root plus a user name, or `/home/<name>`)
  become `/home/user`; per-user temp paths become `/tmp/`;
- the user name and the host name become `user` and `host`;
- emails, HTTP auth headers (token and basic schemes), key or token assignments, keys with
  the OpenAI or Anthropic prefix, GitHub,
  Slack, AWS and Google keys, JWTs, private keys, hex runs of 32+ characters
  and long random base64 runs become placeholders (`[email]`, `[auth]`,
  `[redacted]`, `[secret]`, `[jwt]`, `[hex]`, `[b64]`);
- each UUID keeps its first 8 characters: `00000000-0000-4000-8000-53f224c38b9e`.

Thinking `signature` values became `[b64]`. Tool ids (`toolu_…`) are kept, so
the stream and the transcript can be joined by tool id.

The test `replay-harness.test.ts` ("fixture scrub check") fails if a fixture,
this README or a golden holds a home path, the user name, a key prefix, an
auth header, the literal key name that the task forbids, an email or a
secret shape (the exact list is in the test and in `LEAK_RULES`). To add a fixture:

```sh
bun ma-sub-agents-plugin/lib/lane/scrub-fixture.ts <sidPrefix> <name> [moreNames...]
```

Then add it to `LANE_FIXTURES` and this table, and run the golden update:
`UPDATE_LANE_GOLDENS=1 bun test ma-sub-agents-plugin/lib/lane/`.
