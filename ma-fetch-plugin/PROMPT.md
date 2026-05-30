Use `Fetch` to retrieve a specific web page through a real JavaScript-rendering headless browser. The page's JavaScript runs, dynamic content loads, and you get back the rendered result in your chosen format.

## When to use `Fetch`

- You need the content of a *specific* URL (one you already know).
- The page needs JavaScript to render (SPAs, dashboards, anything dynamic).
- You want clean markdown for reading rather than raw HTML.
- You want to extract links from a page (`format: "links"`).
- You need to grab raw bytes - JSON, an image, a JS bundle (`format: "original"`).

## When NOT to use `Fetch`

- You're searching for information without a known URL → use `WebSearch`.
- The user already pasted the content in the conversation.
- A plain `curl` would suffice and the page is static HTML - but if in doubt, prefer `Fetch` since it handles JS rendering for the same cost.
- The URL points to a *file* on the local disk → use `Read`.

## How to call it well

- **Default to `format: "markdown"`** for articles, docs, blog posts. The output is small, model-readable, and links are preserved.
- **Use `format: "links"`** when you want to crawl - fastest way to enumerate hrefs on a page.
- **Use `format: "original"`** for JSON APIs, images, JS bundles, CSS, or anything where you specifically don't want the HTML/DOM layer.
- **Use `format: "text"`** when markdown markup itself is noise - useful for paragraph-heavy reading or text extraction pipelines.
- **Default `wait_until` is `domcontentloaded`.** It captures the SSR'd initial DOM, which is where article content lives. The fancier `load` default that other tools use waits for *all* subresources (ads, fonts, analytics pixels); on stealth-protected sites that race ends in a nav-only shell because anti-bot scripts rewrite the DOM mid-load. Leave the default alone unless you have a reason.
- **Use `wait_until: "networkidle0"`** for SPAs / dashboards that load content *after* the initial paint via fetch/XHR. Slower (waits for ~500ms of network idleness) but reliable for shells that hydrate client-side.
- **Use `wait_until: "load"`** when you specifically need every subresource (images, fonts, stylesheets) to have arrived, e.g. for screenshot-adjacent workflows. Rarely the right call for text content.
- **Use `selector`** when you only care about one piece of the page  - the browser waits for that element before dumping. Pairs well with dynamic pages.
- **Bump `timeout_sec`** if a page is slow. Default is 30s, max is 120.
- **Use `cleanup: "aggressive"`** when a page comes back with lots of blank lines / NBSPs / zero-width chars wasting your preview budget (common on Bloomberg, Wikipedia, GitHub nav-heavy pages: ~30 %+ of lines are blank separators around every block). Aggressive folds unicode whitespace and drops ALL blank lines. Markdown rendering may break (headings won't pair with adjacent lists in strict parsers) but the model reads lines, so that's fine. Default `"basic"` keeps single blank lines as paragraph separators. Use `"off"` only for verbatim diffing. The `<ma::agent::raw-output .../>` blob already preserves the pre-cleanup bytes regardless of level.

## Persistent sessions (cookies + `localStorage`)

`Fetch` is stateless by default. Pass `session: "<name>"` to keep cookies and `localStorage` alive across calls, and a follow-up call with the same name comes back logged in.

- **When to use it.** Workflows that need authentication: scraping a Twitter / X account, paging through LinkedIn search, hitting a rate-limited dashboard with a session token, anything where round 2 needs round 1's logged-in state.
- **When NOT to use it.** One-shot reads of public pages. Don't pay the disk-I/O tax for a single `Fetch`.
- **The shape.** Names are alnum + `-`/`_`, 1–64 chars, must start with alnum. Each name is sandboxed under `~/.minimal-agent/sessions/fetch/<name>/`. You cannot pass an absolute path, only names.
- **First call usually logs in.** Use `eval` to fill in form fields and submit:
  ```
  Fetch({
    url: "https://twitter.com/login",
    session: "twitter",
    eval: "document.querySelector('form').username.value='me'; ...; document.querySelector('form').submit(); 'ok'"
  })
  ```
- **Later calls just hit the URL.** The saved cookies + `localStorage` are restored before the page loads:
  ```
  Fetch({ url: "https://twitter.com/home", session: "twitter", format: "text" })
  ```
- **Pass `session: ""` to opt out of any config-default session for one call** (rare; only matters if the user configured a `defaults.session`).
- **The transcript footer shows the session name** when it was used (`session: twitter`), so the user can see which jar the call touched.
- **Plaintext on disk.** Cookies + tokens land in plain JSON under `~/.minimal-agent/sessions/fetch/<name>/`. Don't pick a session name that includes the user's identity if other people might see the transcript. The directory inherits the user's home permissions; treat it like a browser profile.
- **Single-writer.** Two `Fetch` calls hitting the same session at the same time will race. Calls are sequential per-turn, so this rarely bites, but be aware.

## Output

- The full page content lands in the tool result (`content` field) for the model to consume.
- The transcript shows a short URL header, a 12-line preview of the body, and a footer with format · size · line count.
- For very large pages the agent's universal output cap kicks in (the full content is still returned, just truncated to fit token budgets).

## Stealth & anti-bot

`Fetch` always renders with anti-detection hardening enabled. It is not a knob the model can toggle: every fetch is stealthy by default.
