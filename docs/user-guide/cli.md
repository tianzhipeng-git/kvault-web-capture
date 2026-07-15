# CLI 使用指南

CLI 与 WebUI 操作同一个数据库和站点存储目录，适合自动化、批处理和无界面环境。除 `site:path-tree --format text` 外，命令输出均为 JSON；路径参数会按当前工作目录解析。

在仓库根目录执行：

```bash
pnpm cli <command> [options]
```

默认使用 `.local/state.db`。如使用其他 SQLite 数据库，传入 `--db /path/to/state.db`；如配置了 `KVAULT_DATABASE_URL`，则使用 PostgreSQL。

运行不带命令的 CLI 可查看完整命令清单。

## 项目与站点

```bash
# 创建项目；返回 id 和 slug
pnpm cli project:create --name "竞品文档"

# 创建站点；--project 是项目 slug
pnpm cli site:create \
  --project jing-pin-wen-dang \
  --name "Example Docs" \
  --base-url https://example.com/docs \
  --storage .local/sites/example-docs

# 删除时需交互确认；自动化中使用 --yes
pnpm cli site:delete --site 1 --yes
pnpm cli project:delete --project 1 --yes
```

## 配置、标签与规则

站点配置和标签定义均使用 JSON 文件。配置格式见 [规则格式编写指南](./site-config-rule-format-guide.md)、[抓取 Profile 配置](./site-config-capture-profile.md) 和 [抓取结果校验](./site-config-validation.md)。

```bash
# 查看、写入或从另一站点复制完整配置
pnpm cli site:config --site 1
pnpm cli site:update-config --site 1 --file ./site-config.json
pnpm cli site:clone-config --from-site 1 --to-site 2

# 兼容原有“从文件导入配置”命令
pnpm cli site:import-config --site 1 --file ./site-config.json

# 查看或更新项目标签定义
pnpm cli project:labels --project 1
pnpm cli project:update-labels --project 1 --file ./labels.json

# 按已保存的规则预览某个 URL 的 base 与第二阶段决策
pnpm cli site:rules-preview \
  --site 1 --url https://example.com/docs/getting-started \
  --labels-file ./page-labels.json
```

`page-labels.json` 是分类结果中的 `labels` 对象，例如：

```json
{
  "content_type": ["docs"]
}
```

规则尚未保存时，可以用 `--rules-before-base-file` 和 `--rules-before-stage2-file` 覆盖对应规则后再预览；两个文件内容分别是规则数组。

## 运行采集与排障

```bash
# 初步摸底
pnpm cli run:seed --site 1 --target-success-count 100

# 按站点配置正式采集
pnpm cli run:crawl \
  --site 1 --update-policy skip_existing

# 只重跑指定 URL；不会从链接继续扩展
pnpm cli run:crawl \
  --site 1 --update-policy force_recrawl_all \
  --urls https://example.com/a,https://example.com/b

# 查询运行、日志与 runtime log
pnpm cli run:list --site 1 --type crawl_run
pnpm cli run:get --run 42
pnpm cli run:logs --run 42 --page-id 18
pnpm cli run:runtime-log --run 42 --tail 500
```

`run:crawl --urls` 会把 `initialUrls` 设置为传入 URL，并将最大深度固定为 `0`，等价于 WebUI 的选中页面重跑。

本地 CLI 可取消没有活动 worker 的孤儿运行：

```bash
pnpm cli run:cancel --run 42
```

若任务由运行中的 Web 服务执行，应由该服务的 coordinator 处理取消。传入 Web 服务地址及 API key：

```bash
pnpm cli run:cancel --run 42 \
  --web-url http://127.0.0.1:3100 \
  --api-key "$KVAULT_API_KEY"
```

## 页面复核与制品

```bash
# 按状态、关键词、标签、待确认原因、来源或 run 筛选页面
pnpm cli site:pages \
  --site 1 --status stage2_pending --label "content_type: docs" \
  --page 1 --page-size 20

# 查看页面详情、历史运行和文本预览
pnpm cli site:page --site 1 --page-id 18

# 对已有页面重新执行分类预览
pnpm cli site:classification-preview --site 1 --page-id 18

# 复制单个 artifact 文件到指定位置
pnpm cli site:artifact-file \
  --site 1 --artifact-run 91 --output ./exports/page.png
```

`site:pages` 还支持 `--query`、`--pending-reason`、`--discovery-source` 和 `--crawl-run-id`。状态值使用数据库中的状态，例如 `stage2_pending`、`stage2_captured`、`url_rule_denied`。

## 系统默认站点与 URL 标准化

默认站点供简易采集 API 使用；默认 Markdown 站点供 Markdown 专用接口使用。设置为 `none` 可清空。

```bash
pnpm cli system:default-site --set 1
pnpm cli system:default-markdown-site --set 2
pnpm cli system:default-site --set none

pnpm cli system:config
pnpm cli system:url-normalization \
  --strip-query-params gclid,fbclid \
  --strip-query-param-prefixes utm_
```

若只传其中一个 URL 标准化参数，另一个参数会保留当前配置。

## 导出

本地导出：

```bash
pnpm cli project:export \
  --project 1 --site-ids 1,2 \
  --artifacts base,markdown,screenshot,structured \
  --output ./exports/project.zip

pnpm cli site:export-pages \
  --site 1 --status stage2_captured --output ./exports/pages.xlsx

pnpm cli site:export-pages-by-ids \
  --site 1 --page-ids 18,19 --output ./exports/pages.zip

pnpm cli run:export --run 42 --output ./exports/run.zip
```

上传 Vault Drive 前，需要配置 Directus/GraphQL 环境与 Google service account（`KVAULT_GOOGLE_SERVICE_ACCOUNT_FILE` 或 `GOOGLE_APPLICATION_CREDENTIALS`）。CLI 会前台等待上传完成并输出最终任务结果：

```bash
pnpm cli vault:projects
pnpm cli vault:export-project --project 1 --target-project-key target-project
pnpm cli vault:export-run --run 42 --target-project-key target-project
pnpm cli vault:export-pages \
  --site 1 --page-ids 18,19 --target-project-key target-project
```

三种 Vault 导出均可附加 `--artifacts base,markdown,screenshot,structured`；项目导出还支持 `--site-ids` 和 `--status`。

## 其他查询

```bash
pnpm cli site:inventory-summary --site 1
pnpm cli site:path-tree --site 1 --format text
pnpm cli site:pending --site 1
pnpm cli site:denied --site 1
pnpm cli site:sample-captures --site 1 --limit 5
pnpm cli link:expand --url https://example.com/sitemap.xml
```
