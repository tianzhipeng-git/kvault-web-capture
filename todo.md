<br />

~~增加一个可配置项，就是页面标准化URL要去除哪些参数，现在已经写死了一些，但是未来可能会为每一个域名配置一些去重时不需要的参数, 我没想好是系统级配置 项目级配置还是站点级配置~~

<br />

一个仅对现有所有已有base的页面进行"打标+规则"的功能, 不爬网站, 单独跑打标的功能

<br />

项目的首页再加一个功能，叫链接展开。如果贴的是一个SideMap，就是SideMap递归展开，如果贴的是一个单页的URL，就临时给它跑一下，然后把里面的子链接全给出来

<br />

保留通过 CLI 直接跑的能力。这是为了未来安在调度机上后，就不用走 HTTP 接口了(这里要注意，python工具所使用的两个 ENV 的合并)。

CLI 里加入一键爬整站的功能，还有一键爬单个 URL 的功能 这个页面里有

<br />

captureProfiles/defaultCaptureProfile 这两个配置项是不是太啰嗦了？其实我们一个站点只会配置一个。

<br />

s是否要新增 Update Policy 这个里如果新加一种策略 就是re evaluate validator

<br />

直接上传oss、vault

<br />

## 更多站点

<br />

andrew提到的Web-Capture升级:

* 电商页

  * 评论(amazon之外的)

* 众筹页+评论

  * 现在那个ks Adapter也是玩闹呢

* 论坛(reddit之外的)

* 独立站

