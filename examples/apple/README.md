# Apple Homepage Example

This example targets `https://www.apple.com/`.

Run the CLI commands one by one against the same `--db` file. Do not start multiple write commands in parallel.

The config is intentionally conservative:

- only `https://www.apple.com/` is seeded
- `seedMaxDepth = 1`
- `crawlMaxDepth = 1`
- `scopelist` keeps requests on `www.apple.com`

That means the default example only processes the homepage itself.

## Create project and site

```bash
node --import tsx src/cli.ts project:create \
  --db examples/apple/.local/state.db \
  --name "Apple Example"
```

```bash
node --import tsx src/cli.ts site:create \
  --db examples/apple/.local/state.db \
  --project apple-example \
  --name apple-homepage \
  --base-url https://www.apple.com \
  --storage examples/apple/.local/storage
```

## Import config

```bash
node --import tsx src/cli.ts site:import-config \
  --db examples/apple/.local/state.db \
  --site 1 \
  --file examples/apple/site-config.json
```

## Run seed pass

```bash
node --import tsx src/cli.ts run:seed \
  --db examples/apple/.local/state.db \
  --site 1
```

Inspect seed state:

```bash
node --import tsx src/cli.ts site:inventory-summary \
  --db examples/apple/.local/state.db \
  --site 1
```

```bash
node --import tsx src/cli.ts site:pending \
  --db examples/apple/.local/state.db \
  --site 1
```

Expected shape after the seed run:

- one homepage inventory row
- pending reason should be `seed_run`

## Run crawl

```bash
node --import tsx src/cli.ts run:crawl \
  --db examples/apple/.local/state.db \
  --site 1 \
  --update-policy force_recrawl_all
```

Read the stored base capture:

```bash
node --import tsx src/cli.ts site:sample-captures \
  --db examples/apple/.local/state.db \
  --site 1 \
  --limit 5
```

If you run both seed and crawl before reading sample captures, the same homepage can appear more than once because the command reads historical `page_runs`.

## Notes

- If you want discovery from the Apple homepage, increase `seedMaxDepth` or `crawlMaxDepth`.
- Increasing depth can expand to many more URLs, so start small.
- Because the current implementation still uses the fake classifier and fake markdown adapter, this example is mainly for validating the workflow, not real content quality.
