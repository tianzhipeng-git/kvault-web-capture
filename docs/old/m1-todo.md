
## 反爬
当前已经用上的：

* **Session Pool**：base、markdown(LinkeDOM)、screenshot(Playwright) 都配置了 sessionPoolOptions: { maxPoolSize: 50 }，见 crawler-factory.ts (line 39)、crawler-factory.ts (line 85)、crawler-factory.ts (line 153)、crawler-factory.ts (line 213)。
* **默认重试**：你没有显式设置 maxRequestRetries，Crawlee 默认是 3 次。503 这类错误通常会先重试，最终耗尽后才进 failedRequestHandler。
* **HTTP 请求不是裸 fetch**：CheerioCrawler / LinkeDOMCrawler 底层用 Crawlee 的 got-scraping HTTP client，比普通 fetch/curl 更像浏览器请求一些。
* **截图阶段用真实浏览器**：PlaywrightCrawler 会跑浏览器；macOS 下如果有系统 Chrome，还会用 Chrome channel，见 crawler-factory.ts (line 214)。

* 没有 retryOnBlocked: true，Crawlee 的“检测 Cloudflare/Incapsula 等拦截页并轮换 session 重试”的逻辑没启用。
* 没有 sameDomainDelaySecs / maxRequestsPerMinute，所以主要靠 maxConcurrency 控制节奏。目前 base 是 5，markdown 是 3，screenshot 是 3。
 
  
但现在**没有用上**这些更关键的反封锁手段：

* 没有 proxyConfiguration，所以没有 IP 轮换。

* 没有 preNavigationHooks 去设置 User-Agent、Accept-Language、Referer、额外 headers。

* markdown 主路径是 LinkeDOMCrawler + Defuddle，这是静态 HTTP 抓取，不是浏览器渲染抓取，见 real-markdown-adapter.ts (line 116)。



## todo



## 已完成
db支持postgresql
部署到ecs美国
重新爬取指定页面的功能
页面详情的弹窗上的 页面url 加上可点击, 新标签页打开
规则的文本描述
skip_existing再次确认, 为啥摸底已经发现是不需要深度爬取, 之后的第一次正式爬取他还是进来了? 正式爬取启动前入队的还是链接发现入队的?
日志更加细致, 方便调试
针对单个页面, 试运行规则看结果
并发
kv store里看到, sessions一大坨, 是不是因为发送的时候没带cookie啊
排除页面上的一些其他资源链接, 比如css链接, xml链接, (pdf链接?), 302无内容的, 404页面
前端, 点击过去可以, 刷新就不行了
失败的页面会不会插入site_pages/page_runs/artifact_runs表
基于llm的classifier.
整理文档
site_pages表增加:打标结果/不采集原因
target-success-count
规则的智能编辑助手功能
导出 (deprt 最终存储目录的问题)
标签规则的逗号分隔没法输入逗号
deprt 规则保存前按照名单类型排序.
克隆配置仅克隆规则(要不要把其他的从json里单独拿出去)

## 小改动
其实现在有可能漏掉页面, 
    比如a页面可能因为rulesBeforeBaseEq规则不入队列, 那a里面的链接就没有机会被发现了, 所以慎用


# strange reminder:
cron类型的
间隔类型的(间隔3天)
倒计时器: 未到达, 已到达