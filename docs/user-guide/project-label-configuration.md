# 项目 Tag（分类标签）配置指南

Tag 用于让 LLM 根据页面的 base 信息进行分类。分类结果可以在页面列表中筛选，也可以被站点的第二阶段规则使用，以决定是否继续采集 Markdown、截图或结构化数据。

Tag 定义属于**项目**：同一项目下的所有站点共用一套定义。它不同于规则编辑器中的“HTML 标签匹配”；后者检查页面里的 HTML 元素，不调用分类器。

## 1. 在 WebUI 中配置

1. 打开项目详情页。
2. 找到“标签定义”。
3. 在“表单模式”中点击“添加标签”。
4. 填写标签字段和可选值，点击“保存表单配置”。

也可以切换到“JSON 高级模式”，粘贴完整配置后点击“保存 JSON 配置”。高级模式适合导入 `vt后台` 导出的标签文件，并会原样保留表单未展示的额外字段。

保存后的定义会用于后续页面分类，不会改写已经保存的历史分类结果。需要验证新定义时，可先在站点的页面复核页选择一个已有 base 结果的页面执行“分类预览”；需要更新正式结果时，再重新采集对应页面。

## 2. 推荐配置格式

```json
{
  "version": 1,
  "labels": [
    {
      "key": "content_type",
      "revision": {
        "name": "页面类型",
        "description": "根据页面的主要用途分类；产品功能介绍归为 product，使用说明和 API 参考归为 docs。",
        "value_type": "single_enum",
        "values_config": {
          "value_type": "single_enum",
          "options": [
            {
              "value": "docs",
              "description": "产品文档、操作指南或 API 参考"
            },
            {
              "value": "product",
              "description": "产品、功能或解决方案介绍页"
            },
            {
              "value": "other",
              "description": "不属于以上类型的页面"
            }
          ]
        },
        "nullable": false,
        "allow_extra_values": false
      }
    },
    {
      "key": "language",
      "revision": {
        "name": "主要语言",
        "description": "页面正文使用的主要语言。",
        "value_type": "single_enum",
        "values_config": {
          "value_type": "single_enum",
          "options": [
            {
              "value": "zh-CN",
              "description": "简体中文"
            },
            {
              "value": "en",
              "description": "英文"
            }
          ]
        },
        "nullable": true,
        "allow_extra_values": true
      }
    }
  ]
}
```

每个标签的字段含义如下：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `key` | 是 | 稳定、唯一的机器标识；站点规则通过它引用标签，例如 `content_type` |
| `revision.name` | 建议 | WebUI 展示名称，也帮助分类器理解标签用途 |
| `revision.description` | 建议 | 分类标准和边界；应说明容易混淆的类别如何区分 |
| `revision.value_type` | 是 | `single_enum`、`multi_enum`、`string`、`number` 或 `boolean` |
| `revision.values_config.value_type` | 是 | 通常与 `revision.value_type` 保持一致 |
| `revision.values_config.options` | 枚举类型建议 | 候选值列表；每项包含稳定的 `value` 和清晰的 `description` |
| `revision.nullable` | 是 | `true` 表示无法判断时可以不返回这个标签 |
| `revision.allow_extra_values` | 是 | `true` 表示允许分类器返回候选列表之外的值 |

分类结果统一保存为 `key -> 字符串数组`，例如：

```json
{
  "content_type": ["docs"],
  "language": ["zh-CN"]
}
```

`single_enum` 通常产生一个值，`multi_enum` 可以产生多个值。对于枚举标签，建议优先使用 `allow_extra_values: false`，避免规则依赖的值发生漂移。

## 3. 编写标签的建议

- `key` 使用小写 snake_case，发布后不要随意修改；修改后引用旧 key 的规则将无法命中。
- `value` 使用短小、稳定的机器值，把解释写在 `description` 中。
- 描述分类边界，而不只是重复名称。例如说明“教程”和“产品介绍”冲突时应归到哪一类。
- 一个标签只表达一个维度。页面类型、语言、受众等应拆成不同标签。
- 只有确实允许多选时才使用 `multi_enum`，否则规则结果更难预测。
- 若下游规则要求标签必有值，设置 `nullable: false`，并提供兜底值（如 `other`）。

## 4. 用 CLI 导入和查看

将上述 JSON 保存为 `labels.json`，然后执行：

```bash
# 写入项目标签定义
pnpm cli project:update-labels --project 1 --file ./labels.json

# 查看当前保存的完整定义
pnpm cli project:labels --project 1
```

CLI 和 WebUI 操作同一个数据库。使用非默认 SQLite 数据库时附加 `--db /path/to/state.db`；使用 PostgreSQL 时设置 `KVAULT_DATABASE_URL`。

## 5. 在站点规则中使用 Tag

Tag 规则放在站点配置的 `rulesBeforeStage2Eq` 中。下面的规则允许 `content_type` 为 `docs` 的页面继续采集 Markdown：

```json
{
  "name": "capture-docs",
  "matchType": "label",
  "listType": "whitelist",
  "when": [
    {
      "key": "content_type",
      "op": "any_of",
      "values": ["docs"]
    }
  ],
  "artifacts": ["markdown"]
}
```

`when` 中的 `key` 和 `values` 必须分别与标签定义中的 `key` 和选项 `value` 完全一致。多个条件会同时满足才算命中。操作符和名单优先级见[站点规则格式编写指南](./site-config-rule-format-guide.md)的 2.2 节。

预览某个 URL 的规则结果时，也可以直接提供模拟分类结果：

```json
{
  "content_type": ["docs"]
}
```

```bash
pnpm cli site:rules-preview \
  --site 1 \
  --url https://example.com/docs/getting-started \
  --labels-file ./page-labels.json
```

注意：`--labels-file` 接收的是上面的**分类结果对象**，不是完整的 Tag 定义文件。

## 6. 常见问题

### 保存了 Tag，为什么旧页面没有变化？

保存定义只影响之后执行的分类。先用页面复核中的“分类预览”检查效果，再按需要重新采集页面。

### 规则一直匹配不到

依次检查：

1. 规则位于 `rulesBeforeStage2Eq`，且 `matchType` 为 `label`。
2. 条件 `key` 与标签定义的 `key` 完全一致。
3. 条件值使用的是选项 `value`，不是选项的中文说明或标签 `name`。
4. 页面详情中的实际分类结果包含目标值。
5. 分类失败的页面会进入 `classifier_failed` 待确认状态，不会正常执行标签匹配。

### 没有配置任何 Tag 会怎样？

当前运行时会使用内置的测试分类器产生示例 `content_type` 标签。正式项目应显式配置自己的 Tag 定义，不要让业务规则依赖该回退行为。
