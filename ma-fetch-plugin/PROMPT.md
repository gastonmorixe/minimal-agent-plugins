The `ma-fetch` plugin contributes a `Fetch` tool for fetching web pages
through a real headless browser (default backend: [obscura][o]). The page's
JavaScript runs, dynamic content loads, and you get back the rendered
result in your chosen format.

[o]: https://github.com/h4ckf0r0day/obscura

## When to use `Fetch`

- You need the content of a *specific* URL (one you already know).
- The page needs JavaScript to render (SPAs, dashboards, anything dynamic).
- You want clean markdown for reading rather than raw HTML.
- You want to extract links from a page (`format: "links"`).
- You need to grab raw bytes - JSON, an image, a JS bundle (`format: "original"`).

## When NOT to use `Fetch`

- You're searching for information without a known URL → use `WebSearch`.
- The user already pasted the content in the conversation.
- A plain `curl` would suffice and the page is static HTML - but if in
  doubt, prefer `Fetch` since it handles JS rendering for the same cost.
- The URL points to a *file* on the local disk → use `Read`.

## How to call it well

- **Default to `format: "markdown"`** for articles, docs, blog posts. The
  output is small, model-readable, and links are preserved.
- **Use `format: "links"`** when you want to crawl - fastest way to
  enumerate hrefs on a page.
- **Use `format: "original"`** for JSON APIs, images, JS bundles, CSS, or
  anything where you specifically don't want the HTML/DOM layer.
- **Use `format: "text"`** when markdown markup itself is noise - useful
  for paragraph-heavy reading or text extraction pipelines.
- **Use `wait_until: "networkidle0"`** for SPAs / dashboards that load
  content after the initial paint. Slower (waits for ~500ms of network
  idleness) but reliable.
- **Use `selector`** when you only care about one piece of the page  - 
  the browser waits for that element before dumping. Pairs well with
  dynamic pages.
- **Bump `timeout_sec`** if a page is slow. Default is 30s, max is 120.

## Output

- The full page content lands in the tool result (`content` field) for
  the model to consume.
- The transcript shows a short URL header, a 12-line preview of the
  body, and a footer with format · size · line count · backend.
- For very large pages the agent's universal output cap kicks in (the
  full content is still returned, just truncated to fit token budgets).

## Stealth & anti-bot

The backend always runs with anti-detection enabled. This is a backend
hygiene concern, not a knob the model can toggle - same will hold if we
swap to a Playwright or curl-impersonate backend later.

## Backend swap

The Fetch tool is backend-agnostic. The current backend lives at
`backends/obscura.ts` and is selected via `plugins["ma-fetch"].backend`
in `~/.minimal-agent/config.jsonc`. The model doesn't need to know which
backend is active.
