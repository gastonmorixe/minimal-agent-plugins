---
title: Fetch persistent sessions and the X case study
created_at: "2026-07-28T18:18:58.999698000-0400"
updated_at: "2026-07-29T00:24:11.467886000-0400"
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
  source_revision: 92f131860d5941c233c66d2bde83b36e56800c5e
  test_session: x-search
  tested_urls:
    - https://x.com/
    - https://x.com/i/flow/login
    - https://twitter.com/login
    - https://x.com/search?q=minimal-agent&src=typed_query&f=live
  credentials_entered: false
  secrets_recorded: false
  last_verified_at: "2026-07-29T00:24:11.467886000-0400"
taillog:
  - "2026-07-28T18:18:58.999698000-0400 | Created living Fetch session guide and recorded the first X/Twitter login and search experiment"
  - "2026-07-28T18:20:33.739484000-0400 | Reviewed implementation claims and added the tested plugin version and source revision"
  - "2026-07-28T18:41:28.346704000-0400 | Aligned the manifest wait_until default with runtime and added a regression test against future drift"
  - "2026-07-29T00:24:11.467886000-0400 | Corrected the X diagnosis: root login renders, eval executes, and old fallback text came from inert noscript content"
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

This difference is central to the X experiment below. Persistence worked, and
a later Obscura build also rendered X's current root login form. Authentication
itself has not yet been attempted.

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

#### 1. Initial legacy-route observation

**Observed, later reinterpreted.** A text dump of
`https://x.com/i/flow/login` contained:

> JavaScript is not available.

That text came from an inert `<noscript>` subtree included by the old text
extractor. It was not proof that X detected disabled JavaScript. Runtime probes
and Obscura diagnostics showed that X's core bundles executed. The old route
also exercised a large dynamic webpack graph that did not always settle before
the bounded watchdog.

#### 2. Verify Fetch's JavaScript environment

**Observed.** Calls in the `x-search` session established that:

- JavaScript expressions execute
- `navigator.cookieEnabled` is `true`
- `localStorage` reads and writes succeed
- the browser exposes a Chrome-like user agent

A direct eval probe on the updated Obscura build returned a generated marker and
`1 + 1 === 2`, confirming page-context execution independently of text
extraction.

#### 3. Render the current root login application

**Observed.** `https://x.com/` reaches `document.readyState === "complete"` and
renders the current X authentication application. The live DOM contains one
form with:

```html
<input id="jf-input-username_or_email" name="username_or_email" type="text">
<input name="password" type="password" inert>
```

The page also exposes phone, Google, and Apple authentication controls. The
password input is initially inert, which is consistent with a staged flow where
the username step must advance first.

This disproves the earlier broad claim that X blocks Fetch or withholds every
login form. Route and backend version matter.

#### 4. Prove persistence independently of login

**Observed.** One call wrote the marker
`__minimal_agent_session_test=persisted` to `localStorage`. A later call using
the same `x-search` session read the same value. The later call also observed X
guest cookies in `document.cookie`.

The marker contains no secret and may be deleted during later cleanup.

#### 5. Try X search before authentication

**Observed.** A request to:

```text
https://x.com/search?q=minimal-agent&src=typed_query&f=live
```

reused the persisted marker but produced no posts while unauthenticated. This
result does not establish that authenticated search is unavailable.

### Current conclusion

**Observed.** Fetch can load X, execute page JavaScript, render the current root
login form, and persist X-origin cookies and `localStorage` across calls. No real
credentials have been entered, so username-step submission, password entry,
challenges, successful authentication, and authenticated search remain unproven.

The legacy-route failure and old no-JavaScript text were diagnostic traps, not
evidence of a site-wide automation block. Always-on stealth remains useful
hygiene, but no anti-bot bypass claim is needed to explain the current result.

## Recommended fallback for X

Fetch is now a viable path for continuing the login investigation. Use a fresh
named session, advance one form step at a time, and inspect the resulting page
before supplying the next value. CAPTCHA, device verification, and 2FA may still
require a human handoff.

Use `ChromeCDP` when an existing real-browser login is preferable or when the
Fetch flow reaches a challenge it cannot complete. Use `WebSearch` with
`site:x.com` only for publicly indexed discovery, not as a replacement for X's
own authenticated search.

## Reproduction recipe

Use a neutral session name and do not enter credentials until the page is known
to present a real login form.

### A. Open and inspect

```json
{
  "url": "https://x.com/",
  "format": "text",
  "wait_until": "networkidle0",
  "timeout_sec": 60,
  "session": "x-search"
}
```

### B. Verify JavaScript and storage capability

```json
{
  "url": "https://x.com/",
  "format": "text",
  "wait_until": "networkidle0",
  "timeout_sec": 60,
  "session": "x-search",
  "eval": "(() => ({ jsRuns: true, url: location.href, readyState: document.readyState, cookieEnabled: navigator.cookieEnabled, localStorageAvailable: (() => { try { localStorage.setItem('__ma_test','1'); localStorage.removeItem('__ma_test'); return true } catch { return false } })(), inputs: [...document.querySelectorAll('input')].map(({type,name,id}) => ({type,name,id})) }))()",
  "eval_mode": "value"
}
```

### C. Prove cross-call persistence with a non-secret marker

Write:

```json
{
  "url": "https://x.com/",
  "format": "text",
  "wait_until": "domcontentloaded",
  "session": "x-search",
  "eval": "(() => { localStorage.setItem('__minimal_agent_session_test', 'persisted'); return localStorage.getItem('__minimal_agent_session_test') })()",
  "eval_mode": "value"
}
```

Read in a later call:

```json
{
  "url": "https://x.com/",
  "format": "text",
  "wait_until": "domcontentloaded",
  "session": "x-search",
  "eval": "(() => ({ persisted: localStorage.getItem('__minimal_agent_session_test'), url: location.href }))()",
  "eval_mode": "value"
}
```

### D. Distinguish eval return modes

`eval_mode: "value"` returns the JavaScript expression's value. This is the
default when `eval` is present. Use `eval_mode: "page"` when the expression
mutates or submits the page and the useful result is the post-evaluation dump.
A `selector` belongs to page mode because it scopes that dump.

### E. Stop before credential entry when blocked

If DOM inspection shows no usable username input, do not inject credentials.
Record the observation and move to a real browser session or a newer backend
build.

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

- Can Fetch advance X's username step and activate the staged password input?
- Which additional verification or anti-abuse challenge appears for a real or
  disposable test account?
- Should Fetch support a safe, explicit import of browser storage rather than
  scripted credential entry?
- Should the plugin add cooperative locking or a clear single-writer error for
  named sessions?
- Should session lifecycle operations such as list, inspect metadata, and
  delete be exposed through an operator-only interface?
