# Request goldens

These tests pin the exact LLM requests the agent builds. They guard prompt
and tool text that moves between core and plugins.

How it works: a stub sendFn replaces the model. The real first-party plugins
load from this repo. Each scenario in scenarios.ts runs a scripted turn. The
harness records tools, system, messages, maxTokens and output config for each
request. It writes canonical JSON (sorted keys, 2-space indent).

Run (inside minimal-agent-plugins):

    bun test tests/request-golden

Update after an intended change:

    UPDATE_REQUEST_GOLDENS=1 bun test tests/request-golden

Then read the diff of tests/request-golden/goldens/ before you commit.

Determinism: fixed clock, temp cwd, HOME and MINIMAL_AGENT_HOME in an empty
temp dir, all MINIMAL_AGENT_* env vars cleared. Temp paths, uuids, durations
and env-info values are replaced by a fixed step in harness.ts.

Add a scenario: add an entry to SCENARIOS in scenarios.ts, then update.
Scratch dirs go to tests/request-golden/.tmp (gitignored, removed after a run).

Files: harness.ts (runner), scenarios.ts (core scenarios), scenarios-extra.ts
(media, resume, kill-resume, stream-salvage, compaction).

Scenario notes:

- resume and kill-resume: run a turn with a SessionStore, load the JSONL with
  loadSession, call replaceMessages and noteSessionResumed on a fresh core.
  kill-resume cuts the JSONL after the last tool_use record.
- stream-salvage: the stub reply carries stopDetails stream_closed_without_terminal.
- tail-compaction: core.compact({mode:"tail"}), the golden is the next request.
- local-compaction: registerTestProvider plus a fake NetworkClient answers the
  summary call (public seam, no core edit). The golden is the next request.
- image-read: a test provider with image modality turns on image blocks.

Env: every MINIMAL_AGENT_* var (including MINIMAL_AGENT_EFFORT) is cleared
during a run and restored after. So a real effort change is not covered here.
Normalization: temp and plugin paths, uuids (any uuid becomes <UUID>) and
"durationMs" values (zeroed everywhere) are replaced. The env-info ini block
keeps its keys and line order. Only the values become <V>, so a key rename fails.

Skills decision: the ma-skills plugin stays loaded. Bun's homedir() ignores
HOME, so an empty HOME is not enough. The harness writes a config.json into the
temp agent home that turns off all four skill roots and extraRoots. The
catalog is empty on every machine. Goldens are equal with any real HOME.

Safety: UPDATE_REQUEST_GOLDENS=1 throws when CI is set. A test asserts that the
golden files equal the scenario names (an extra golden fails).
Size: each golden holds the full system and tools block (about 100 KB). Not deduped
on purpose, see research/s0.1-worker2-report.md.

## Extra plugin roots

A scenario can set `pluginRoots: ({ root, cwd }) => string[]` to load more plugin
dirs. The harness appends them after the plugins root. If the field is absent,
only the plugins root loads, so existing goldens do not change.

Grep errors: normalizeText keeps the prefix "Grep error: " and replaces the rest of the string with <RG_STDERR>. rg stderr differs per version.
A scenario can set needsRg: true. runScenario then throws RgMissingError when rg is not on PATH. Other scenarios still run.

A scenario can set `noExecutor: true`. The harness then builds a plain AgentCore with NO_TOOLS_EXECUTOR and one listed stub tool, not buildTestCore.
Its system block is a short fixed string by design. If the field is absent, nothing changes.
