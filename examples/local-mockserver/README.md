# Local Mock Server Example

This example uses a tiny local site to demonstrate the current M1 workflow end to end.

Run the CLI commands one by one against the same `--db` file. Do not start multiple write commands in parallel.

## Files

- `mock-server.ts`: local HTTP server
- `site-config.json`: example site config for the server running on port `4318`

## Start the mock server

From the repo root, in terminal 1:

```bash
node --import tsx examples/local-mockserver/mock-server.ts --port 4318
```

The server exposes:

- `http://127.0.0.1:4318/docs`
- `http://127.0.0.1:4318/product`
- `http://127.0.0.1:4318/support`
- `http://127.0.0.1:4318/login`
- `http://127.0.0.1:4318/sitemap.xml`

## Create project and site

From the repo root, in terminal 2:

```bash
node --import tsx src/cli.ts project:create \
  --db examples/local-mockserver/.local/state.db \
  --name "Mock Example"
```

```bash
node --import tsx src/cli.ts site:create \
  --db examples/local-mockserver/.local/state.db \
  --project mock-example \
  --name mock-site \
  --base-url http://127.0.0.1:4318 \
  --storage examples/local-mockserver/.local/storage
```

## Import config

```bash
node --import tsx src/cli.ts site:import-config \
  --db examples/local-mockserver/.local/state.db \
  --site 1 \
  --file examples/local-mockserver/site-config.json
```

## Run inventory preview

```bash
node --import tsx src/cli.ts run:preview \
  --db examples/local-mockserver/.local/state.db \
  --site 1
```

Useful read commands after preview:

```bash
node --import tsx src/cli.ts site:inventory-summary \
  --db examples/local-mockserver/.local/state.db \
  --site 1
```

```bash
node --import tsx src/cli.ts site:pending \
  --db examples/local-mockserver/.local/state.db \
  --site 1
```

```bash
node --import tsx src/cli.ts site:denied \
  --db examples/local-mockserver/.local/state.db \
  --site 1
```

Expected shape after preview:

- `/login` should be `url_rule_denied`
- `/docs`, `/product`, `/support` should be `pending`
- pending reason should be `preview_run`

## Run crawl

```bash
node --import tsx src/cli.ts run:crawl \
  --db examples/local-mockserver/.local/state.db \
  --site 1 \
  --update-policy force_recrawl_all
```

Read the resulting sample captures:

```bash
node --import tsx src/cli.ts site:sample-captures \
  --db examples/local-mockserver/.local/state.db \
  --site 1 \
  --limit 10
```

Expected shape after crawl:

- `/docs`, `/product`, `/support` should have base captures
- allowed pages should also have markdown artifact runs
- `/login` should still stay denied
- `site:sample-captures` reads historical `page_runs`, so if you ran both preview and crawl, duplicate URLs are expected in the output
