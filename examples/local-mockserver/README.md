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
- `http://127.0.0.1:4318/not-exists` (returns 404)
- `http://127.0.0.1:4318/sitemap.xml`

## Page tree

The mock site structure in [mock-server.ts](/Users/tianzhipeng/Documents/private/cnm/vt/kvault-web-capture/examples/local-mockserver/mock-server.ts) is:

```text
/
└── /docs
    ├── /product
    │   ├── /support
    │   └── /not-exists (404)
    ├── /support
    └── /login

sitemap.xml
├── /docs
└── /login
```

Important details for this example:

- `/` links to `/docs`, but `/` is not in the example `seedUrls` or `sitemaps`, so it is not part of the default run.
- `sitemap.xml` directly lists `/docs` and `/login`.
- the example config seeds `/docs` and also provides `sitemap.xml`, so startup input is:
  - `seedUrls`: `/docs`
  - `sitemaps`: `/docs`, `/login`
- `/login` is blocked by the URL blacklist, so it is discovered but not crawled.

## How `seedMaxDepth` and `crawlMaxDepth` work

These two parameters control page-link recursion depth after a startup page has entered the `base` queue.

- `seedMaxDepth` applies only to `run:seed`
- `crawlMaxDepth` applies only to `run:crawl`
- sitemap expansion happens before page crawling, so sitemap recursion is not counted by either depth
- startup pages from `seedUrls` or `sitemaps` enter the `base` queue at depth `0`
- links found on a depth `0` page are depth `1`
- links found on a depth `1` page are depth `2`

Using the current example config:

- `seedMaxDepth = 1`
- `crawlMaxDepth = 2`

That means:

- `run:seed` will crawl startup pages at depth `0`, then follow one layer of page links
- `run:crawl` will crawl startup pages at depth `0`, then follow up to two layers of page links

In this mock tree, the concrete effect is:

- with depth `0`
  - crawled pages: `/docs`
  - discovered but not followed from page links: `/product`, `/support`, `/login`
  - startup sitemap `/login` is still seen, but denied by URL rules
- with depth `1`
  - crawled pages: `/docs`, `/product`, `/support`
  - `/support` is reached from `/docs`
  - `/login` is still denied, so it never enters base capture
- with depth `2`
  - crawled pages are still `/docs`, `/product`, `/support`
  - `/product -> /support` adds no new page because `/support` was already discovered at depth `1`

So for this specific mock site:

- `seedMaxDepth = 1` is already enough to cover every allowed page in the tree
- `crawlMaxDepth = 2` behaves the same as `1` for coverage, but proves the crawler can continue one more level if the tree grows later

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

## Run seed pass

```bash
node --import tsx src/cli.ts run:seed \
  --db examples/local-mockserver/.local/state.db \
  --site 1
```

Useful read commands after the seed run:

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

Expected shape after the seed run:

- `/login` should be `url_rule_denied`
- `/docs`, `/product`, `/support` should be `pending`
- pending reason should be `seed_run`

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
- `site:sample-captures` reads historical `page_runs`, so if you ran both seed and crawl, duplicate URLs are expected in the output


## 手动模拟更新策略
1. seed运行后: 4个pages, 1次crawl run, 3次page runs, 0次artifact runs
2. skip_existing模型crawl: 2次crawl run, 6次page runs, 3次artifact runs(都是markdown)
3. 再次skip_existing模型crawl: 3次crawl run, 6次page runs, 3次artifact runs(都是markdown)
4. force_recrawl_all: 4次crawl run, 9次page runs, 6次artifact runs(都是markdown)
5. 修改config, 加入如下, 启动skip_existing
  ```
    {
      "name": "screenshot_product",
      "matchType": "label",
      "listType": "whitelist",
      "when": [
        {
          "key": "content_type",
          "op": "any_of",
          "values": [
            "product"
          ]
        }
      ],
      "artifacts": [
        "screenshot"
      ]
    }
  ```
  5次crawl run, 10次page runs, 6次artifact runs(1次screenshot)