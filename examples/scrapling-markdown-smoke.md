# Scrapling Markdown Smoke Test

This example calls the same Python bridge script used by `scrapling-page` and verifies that a URL can be converted to Markdown.

## Run

Print Markdown to stdout:

```bash
pnpm exec tsx examples/scrapling-markdown-smoke.ts https://example.com
```

Write Markdown to a file:

```bash
pnpm exec tsx examples/scrapling-markdown-smoke.ts https://example.com /tmp/example.md
```

Launch CloakBrowser and pass its CDP websocket URL to Scrapling:

```bash
pnpm exec tsx examples/scrapling-markdown-smoke.ts https://example.com /tmp/example.md --cloakbrowser
```

Show the CloakBrowser window:

```bash
pnpm exec tsx examples/scrapling-markdown-smoke.ts https://example.com /tmp/example.md --cloakbrowser --headed
```

Use a proxy:

```bash
pnpm exec tsx examples/scrapling-markdown-smoke.ts https://example.com /tmp/example.md --proxy http://127.0.0.1:7890
```

## Python Environment

The script follows the project's Python lookup order:

1. `KVAULT_PYTHON_SCRAPLING`
2. `KVAULT_PYTHON`
3. `.venv/bin/python`
4. `.venv-scrapling/bin/python`
5. `python3`

You can override it directly:

```bash
pnpm exec tsx examples/scrapling-markdown-smoke.ts https://example.com /tmp/example.md --python .venv/bin/python
```

Install Python dependencies as described in `docs/user-guide/pytools-install.md`.

## Python Script Path

The script looks for `scrapling_tool.py` in these locations:

1. `src/capture/pytools/scrapling_tool.py`
2. `dist/src/capture/pytools/scrapling_tool.py`

If your server layout is different, pass it explicitly:

```bash
pnpm exec tsx examples/scrapling-markdown-smoke.ts https://example.com /tmp/example.md --script /path/to/dist/src/capture/pytools/scrapling_tool.py
```

## Notes

- Without `--cloakbrowser`, Scrapling uses its own browser path and receives `proxyUrl` directly.
- With `--cloakbrowser`, the script starts CloakBrowser with a remote debugging port and passes `cdpWebSocketUrl` into `scrapling_tool.py`.
- When writing to a file, stdout prints a small JSON summary with `markdownLength` and Scrapling diagnostics.
- If a real site appears to hang while `example.com` works, first compare the default path with `--cloakbrowser`. The project Scrapling bridge uses `network_idle=False`, `solve_cloudflare=True`, a 10-second soft `networkidle` wait in `page_action`, and a 180-second total timeout in both modes.
