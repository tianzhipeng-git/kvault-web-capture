# Examples

This directory contains two runnable examples for the current M1 CLI implementation.

## Running notes

- Run CLI commands sequentially when they target the same `--db` file.
- The current SQLite-based implementation is not intended for concurrent writes from multiple CLI processes.

## Included examples

### `local-mockserver`

Use a local HTTP server with a tiny sitemap and a few HTML pages.

This example is the best way to verify:

- `site:create`
- `site:import-config`
- `run:preview`
- `run:crawl`
- `site:inventory-summary`
- `site:pending`
- `site:denied`
- `site:sample-captures`

See [examples/local-mockserver/README.md](/Users/tianzhipeng/Documents/private/cnm/vt/kvault-web-capture/examples/local-mockserver/README.md).

### `apple`

Use `https://www.apple.com/` as a real public site example.

This example is intentionally conservative:

- only the homepage is targeted by default
- `previewMaxDepth` and `crawlMaxDepth` are both `0`
- the config uses a `scopelist` rule to stay on `www.apple.com`

See [examples/apple/README.md](/Users/tianzhipeng/Documents/private/cnm/vt/kvault-web-capture/examples/apple/README.md).
