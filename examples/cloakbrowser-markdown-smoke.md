# CloakBrowser Markdown Smoke Test

This example opens a URL with CloakBrowser, extracts the rendered HTML, and converts it to Markdown with Defuddle.

## Run

Print Markdown to stdout:

```bash
pnpm exec tsx examples/cloakbrowser-markdown-smoke.ts https://example.com
```

Write Markdown to a file:

```bash
pnpm exec tsx examples/cloakbrowser-markdown-smoke.ts https://example.com /tmp/example.md
```

Show the browser window:

```bash
pnpm exec tsx examples/cloakbrowser-markdown-smoke.ts https://example.com /tmp/example.md --headed
```

Wait longer after navigation for client-rendered pages:

```bash
pnpm exec tsx examples/cloakbrowser-markdown-smoke.ts https://example.com /tmp/example.md --settle-ms 5000
```

## Notes

- CloakBrowser's CLI is for binary management, such as `install`, `info`, and `update`.
- URL to Markdown needs a small script: CloakBrowser loads the page, then Defuddle converts the HTML.
- On first run, CloakBrowser may download its Chromium binary.
