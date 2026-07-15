### cli升级

保留通过 CLI 直接跑的能力。这是为了未来安在调度机上后，就不用走 HTTP 接口了(这里要注意，python工具所使用的两个 ENV 的合并)。

CLI 里加入一键爬整站的功能，还有一键爬单个 URL 的功能 这个页面里有

CLI的打包方式优化一下 让用户能直接通过一个命令执行

~~是否要新增 Update Policy 这个里如果新加一种策略 就是re evaluate validator?~~

### 其他

~~速度的问题~~

把web-capture的skill完成

把web-capture截图能力大升级

微信公众号爬虫

~~真.进度 成功数量, 防止A镇他以为没有进度~~

## skill写法

通过cli交互; 不连接线上pg库, 而是本地sqlite;

#### 项目级配置

#### 站点级配置

1. 先根据自己的了解和sitemap.xml理解网站大概结构
2. 初步请求单个网页看看结果
3. 编写base入队规则

   1. 必定配置的一个前缀scopelist, 我们一般只针对单个站点内容, 不会跨多个站点
   2. 一定要注意的多语言、多国家站点 scopelist或拉黑

      1. 子目录 如: example.com/us/
      2. 子域名 如: us.example.com
      3. 国家顶级域名 如 example.us, example.co.uk, example.com.cn
      4. 参数模式 如 example.com?lang=en\&country=us
   3. 登录后才可以用的url拉黑
4. 编写深度爬取规则
5. 先跑一次初步摸底, 根据结果调整上述规则
6. 再跑一次小批量的正式运行, 根据artifact调整  浏览器、结果校验、爬取profile 规则

   如果运行过程中发现通过Base入队规则的页面数超过了一万 就要杀掉并分析原因, 防止被Spider Trap或Crawler Black Hole陷住
7. 根据效果再试运行和调整, 没问题后提交完整正式运行

<br />

## 更多站点

andrew提到的Web-Capture升级:

* 电商页

  * 评论(amazon之外的)

* 众筹页+评论

  * 现在那个ks Adapter也是玩闹呢

* 论坛(reddit之外的)

* 独立站

* 微信公众号

