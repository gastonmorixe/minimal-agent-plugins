---
title: Fetch persistent sessions and the X case study
created_at: "2026-07-28T18:18:58.999698000-0400"
updated_at: "2026-07-28T18:41:28.346704000-0400"
session_id: 0d186838-8d92-4f91-b46e-54e012cddd98
host_info:
  hostname: macbookpro.home.arpa
  user: gaston
  os: "macOS 27.0 (26A5388g)"
  kernel: "27.0.0"
  arch: arm64
  serial: FHQ93DD9T6
tags: [fetch, persistent-sessions, authentication, x, twitter, anti-bot, research-log]
audit:
  document_status: living
  evidence_policy: distinguish-implementation-observation-and-inference
  plugin_version: 0.1.0
  source_revision: 35a4c15ee0ddc94821ffd0dffdd5c15e1ac53b7f
  test_session: x-search
  tested_urls:
    - https://x.com/i/flow/login
    - https://twitter.com/login
    - https://x.com/search?q=minimal-agent&src=typed_query&f=live
  credentials_entered: false
  secrets_recorded: false
  last_verified_at: "2026-07-28T18:41:28.346704000-0400"
taillog:
  - "2026-07-28T18:18:58.999698000-0400 | Created living Fetch session guide and recorded the first X/Twitter login and search experiment"
  - "2026-07-28T18:20:33.739484000-0400 | Reviewed implementation claims and added the tested plugin version and source revision"
  - "2026-07-28T18:41:28.346704000-0400 | Aligned the manifest wait_until default with runtime and added a regression test against future drift"
---

# Fetch persistent sessions and the X case study

This is a living technical note for `ma-fetch-plugin`. It records what the
plugin promises, what its implementation and tests prove, and what happened in
real Fetch calls. X, formerly Twitter, is the first case study because it
combines client-side rendering, authentication, persistent browser state, and
aggressive browser-environment checks.

Update this page as the implementation or observed site behavior changes. Keep
the audit metadata and taillog append-only.

## Evidence labels

Statements in this document use three labels:

- **Implemented** means the behavior is visible in plugin source or tests.
- **Observed** means it occurred in an actual Fetch call and may change when the
  site or browser backend changes.
- **Inferred** means it is the current explanation, not a proven root cause.

This distinction matters for anti-bot behavior. A site's error text is not
always a truthful diagnosis.

## Persistent session model

**Implemented.** Fetch is stateless unless a session is selected. Passing the
same non-empty `session` name on related calls gives the backend the same
storage directory. The current Obscura backend forwards that directory through
`--storage-dir`, which persists cookies and `localStorage` across processes.

```text
Fetch input
  session: "x-search"
        |
        v
<storageRoot>/x-search
        |
        v
MA_FETCH_STORAGE_DIR
        |
        v
obscura --storage-dir <storageRoot>/x-search
```

The default root is:

```text
<MINIMAL_AGENT_HOME>/sessions/fetch/
```

In a normal installation, `MINIMAL_AGENT_HOME` resolves to
`~/.minimal-agent`, so the familiar path is:

```text
~/.minimal-agent/sessions/fetch/x-search/
```

Do not hard-code that familiar path in implementation code. The plugin honors
`MINIMAL_AGENT_HOME`, and operators can configure an absolute `storageRoot`.

### Session selector semantics

| Call input | Effective behavior |
|---|---|
| `session` omitted | Use `defaults.session` if configured, otherwise run statelessly |
| `session: "x-search"` | Use `<storageRoot>/x-search` |
| `session: ""` | Explicitly opt out of a configured default for this call |

A non-empty session name must match:

```regex
^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$
```

So names are 1 to 64 characters, start with an alphanumeric character, and use
only alphanumerics, `-`, or `_`. Slashes, dots, spaces, and traversal forms such
as `..` are rejected. The resulting directory is therefore a direct child of
`storageRoot`, not an arbitrary model-selected filesystem path.

### What persistence does and does not guarantee

A persistent jar guarantees browser state reuse. It does not guarantee:

- that a site will present a usable login form
- that scripted login will avoid CAPTCHA, 2FA, or device verification
- that anti-bot checks will accept the browser backend
- that a saved session remains valid after server-side expiry or revocation
- that two concurrent writers can safely share one session

This difference is central to the X experiment below. Persistence worked. X
access did not.

## Security and operational constraints

### Treat session storage like a browser profile

**Implemented and documented by the plugin.** Cookies and `localStorage` are
stored as plaintext JSON by the current backend. Sites may keep authentication
tokens in either one. The storage inherits local filesystem permissions and
must be handled like a Chrome profile directory.

Practical rules:

1. Never put passwords, tokens, or account identifiers in this document.
2. Prefer neutral names such as `x-search` over names containing a person's
   handle, email address, or organization.
3. Do not commit session directories.
4. Remove a jar when it is no longer needed or when access should be revoked
   locally. Server-side logout or token revocation may still be necessary.
5. Avoid inspecting or copying cookie files unless debugging explicitly
   requires it.

### One writer per session

**Implemented limitation.** There is no cross-process or cross-agent lock for a
Fetch session. Two calls using the same session concurrently may race while
reading or writing cookies and `localStorage`.

Use distinct names for concurrent workflows, or serialize calls that must share
one login. Calls made by one agent are normally sequential, but separate agents
or top-level sessions can overlap.

### JavaScript evaluation is page-context execution

The `eval` parameter runs JavaScript in the loaded page. It can inspect the DOM,
read non-HttpOnly browser state available to that origin, fill fields, and
submit forms. Treat it as a powerful browser action.

Avoid embedding credentials directly in a tool call. Tool inputs and outputs
can appear in transcripts. Prefer an existing logged-in browser through
`ChromeCDP` when a site supports neither automated login nor a safe handoff.

## Choosing Fetch options for authenticated sites

- Start with `wait_until: "domcontentloaded"`. It is the plugin's runtime
  default and often captures server-rendered content before later scripts
  replace it.
- Use `networkidle0` for a client-rendered application whose useful content
  arrives through later requests.
- Use `load` only when full subresource completion matters.
- Use `eval` for targeted inspection before attempting form interaction.
- Keep one named `session` across every step that must share state.
- Use `format: "text"` when inspecting page state without markdown noise.
- Use `cleanup: "off"` when exact whitespace or source fidelity matters.

The manifest's JSON Schema and runtime configuration both default to
`domcontentloaded`. A regression test compares the schema value with
`defaultConfig().defaults.waitUntil` so these surfaces cannot silently drift
again. An operator-configured `defaults.waitUntil` still takes precedence over
the built-in value when the call omits `wait_until`.

## Case study: X/Twitter

### Goal

Determine whether Fetch can:

1. open X's login flow
2. retain cookies and `localStorage` in a named session
3. authenticate through the rendered page
4. use the same session for X search

The test session was `x-search`. No credentials were entered.

### Experiment log

#### 1. Open the X login flow

**Observed.** A request to `https://x.com/i/flow/login` with
`wait_until: "networkidle0"` returned X's fallback page:

> JavaScript is not available.

The same page also suggested enabling JavaScript or using a supported browser.

#### 2. Verify Fetch's JavaScript environment

**Observed.** A second call in the same `x-search` session evaluated JavaScript
successfully and reported:

- JavaScript execution succeeded
- `navigator.cookieEnabled` was `true`
- a `localStorage` write and delete succeeded
- the browser exposed a Chrome-like user agent

Therefore, X's message was not a literal report that Fetch had disabled
JavaScript.

#### 3. Try the legacy Twitter entry point

**Observed.** `https://twitter.com/login` redirected to
`https://x.com/login` and returned the same fallback. DOM inspection found only
a hidden `failedScript` input and a `Try again` button, not a usable login form.

There was no safe authentication step to perform.

#### 4. Prove persistence independently of login

**Observed.** One call wrote the marker
`__minimal_agent_session_test=persisted` to `localStorage`. A later call using
the same `x-search` session read the same value. The later call also observed X
guest cookies in `document.cookie`.

This isolates the result:

- Fetch session persistence worked.
- X still rejected or degraded the browser environment.

The marker contains no secret and may be deleted during later cleanup.

#### 5. Try X search

**Observed.** A request to:

```text
https://x.com/search?q=minimal-agent&src=typed_query&f=live
```

reused the persisted marker but returned the same fallback page. No `article`
elements were present, so no posts were available to extract.

### Current conclusion

**Observed.** Fetch can execute JavaScript and persist X-origin cookies and
`localStorage` across calls. In this environment, X did not expose its login or
search application to the Fetch backend.

**Inferred.** X likely rejected some property of the automated browser or
request environment and used a generic "JavaScript is not available" fallback.
The experiment did not identify the exact signal. Do not document the cause as
proven browser fingerprinting until diagnostics establish it.

Always-on stealth is a useful baseline, not a promise that every site's checks
will pass.

## Recommended fallback for X

Use `ChromeCDP` when the task requires actual X login or search. It operates in
the user's real Chrome profile, so it can reuse a login the user completed in a
normal browser and can handle challenges Fetch cannot safely automate.

Use `WebSearch` with `site:x.com` only for publicly indexed discovery. It is not
a replacement for X's own live or complete search results.

## Reproduction recipe

Use a neutral session name and do not enter credentials until the page is known
to present a real login form.

### A. Open and inspect

```json
{
  "url": "https://x.com/i/flow/login",
  "format": "text",
  "selector": "body",
  "wait_until": "networkidle0",
  "timeout_sec": 45,
  "session": "x-search"
}
```

### B. Verify JavaScript and storage capability

```json
{
  "url": "https://x.com/login",
  "format": "text",
  "wait_until": "load",
  "timeout_sec": 45,
  "session": "x-search",
  "eval": "(() => ({ jsRuns: true, url: location.href, cookieEnabled: navigator.cookieEnabled, localStorageAvailable: (() => { try { localStorage.setItem('__ma_test','1'); localStorage.removeItem('__ma_test'); return true } catch { return false } })(), text: document.body.innerText.slice(0,1000) }))()"
}
```

### C. Prove cross-call persistence with a non-secret marker

Write:

```json
{
  "url": "https://x.com/login",
  "format": "text",
  "wait_until": "domcontentloaded",
  "session": "x-search",
  "eval": "(() => { localStorage.setItem('__minimal_agent_session_test', 'persisted'); return localStorage.getItem('__minimal_agent_session_test') })()"
}
```

Read in a later call:

```json
{
  "url": "https://x.com/login",
  "format": "text",
  "wait_until": "domcontentloaded",
  "session": "x-search",
  "eval": "(() => ({ persisted: localStorage.getItem('__minimal_agent_session_test'), url: location.href }))()"
}
```

### D. Stop before credential entry when blocked

If DOM inspection shows only the fallback and no real username input, do not
attempt to inject credentials. Record the observation and move to a real
browser session.

## Maintenance checklist

When rerunning this study:

1. Refresh `updated_at`, `session_id`, `audit.last_verified_at`, and the taillog.
2. Record the backend/plugin version if it becomes available at the tool
   boundary.
3. Keep raw account data, cookies, tokens, and passwords out of the document.
4. Separate new observations from explanations.
5. Record whether X presented a login form, a challenge, search results, or a
   fallback.
6. Verify persistence with a non-secret marker rather than an authentication
   token.
7. Note whether a real browser fallback succeeded.

## Implementation references

These paths are the current sources of truth:

- `manifest.json`: public Fetch schema and parameter descriptions
- `PROMPT.md`: model-facing usage policy
- `handlers/fetch.ts`: validation, default merging, session directory
  resolution, and transcript footer behavior
- `lib/config.ts`: runtime defaults, storage root, and session-name validation
- `lib/paths.ts`: `MINIMAL_AGENT_HOME` resolution
- `lib/backend.ts`: environment construction and backend dispatch
- `backends/obscura.ts`: `MA_FETCH_STORAGE_DIR` to `--storage-dir` forwarding
- `handlers/fetch.test.ts`: session validation and path sandbox tests
- `lib/config.test.ts`: storage root and default-session tests
- `backends/obscura.test.ts`: persistence argument forwarding tests

## Open questions

- Which browser-environment signal causes X to serve the fallback?
- Can a newer Obscura build or backend configuration reach X's login form?
- Should Fetch support a safe, explicit import of browser storage rather than
  scripted credential entry?
- Should the plugin add cooperative locking or a clear single-writer error for
  named sessions?
- Should session lifecycle operations such as list, inspect metadata, and
  delete be exposed through an operator-only interface?
