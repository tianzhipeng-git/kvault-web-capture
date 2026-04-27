# Kvault Web Capture Frontend

本目录包含了 Kvault Capture 系统的 Web 前端应用代码。该界面旨在为爬虫任务的管理、监控和配置提供一个现代化、易用且以业务概念为核心的控制台。

## 技术栈与设计 (Tech Stack & Design)

- **框架**: React 18 + Vite
- **路由**: React Router v6
- **样式**: Tailwind CSS v3
- **组件库**: 基于 Radix UI 封装的 shadcn/ui 组件体系
- **动画**: Framer Motion

### 界面结构与业务概念
前端在设计上剥离了底层的技术细节（如具体的 `page_runs` 和 `artifact_runs`），将重点放在业务人员更关心的维度上：

1. **项目管理 (Projects)**
   - 系统的最顶层概念，用于将不同的业务线或相关的站点聚合在一起管理。
2. **站点详情 (Project Details / Sites)**
   - 在项目内部，管理多个具体的采集目标站点（Site），展示各站点的基本信息和 URL 入口。
3. **站点控制台 (Site Dashboard)**
   - 针对单一站点的操作和监控中心，分为四个主要模块：
     - **站点概览 (Overview)**：展示站点的宏观数据，如已知页面、已抓取、待复核等核心指标。
     - **规则配置 (Config)**：编辑该站点的抓取规则（包含 URL 黑白名单、label 规则等）。
     - **采集流程 (Pipeline)**：使用流程图/向导的模式，引导用户按步骤"初步摸底 (Seed Run)" -> "正式采集 (Crawl Run)"
     - **页面清单 (Pages)**：呈现被发现的所有页面及其业务状态。用户可点击单行查看该页面的具体底层运行记录（如 Base、Markdown 和 Screenshot 状态）。

## 前后端配合

- 后端 API 提供：后端 (src/web/server.ts) 基于 Fastify 构建，在 /api/* 路径下提供了一套 RESTful API（例如 /api/projects, /api/sites, /api/auth/login 等）。后端负责底层的核心业务逻辑，比如与 SQLite 数据库交互 (state.db)、启动爬虫任务（seed, crawl）以及处理身份验证（SessionAuth）。
- 前端数据渲染：前端 (src/web/frontend) 是一个 React 单页应用 (SPA)。它通过调用后端的 /api/* 接口来获取数据并展示（例如项目列表、站点状态、采集流水线），同时通过接口触发后端的操作。
- 命令行工具补充：此外，src/cli.ts 提供了一个直接调用后端核心服务 (M1App) 的命令行界面。CLI 绕过了 HTTP API，直接对数据库进行操作或启动采集任务。这通常用于管理维护、自动化脚本或无头环境（Headless）。

## 如何使用 (Usage)

### 开发模式 (Development)

在开发阶段，你可以独立运行前端以获得模块热替换（HMR）等特性。

1. 进入前端目录：
   ```bash
   cd src/web/frontend
   ```
2. 安装依赖：
   ```bash
   npm install
   ```
3. 启动 Vite 开发服务器：
   ```bash
   npm run dev
   ```

*注：在独立开发时，前端界面的 API 请求需要发往真实的后端服务（通常运行在 `http://127.0.0.1:3100`）。在实际使用时，可以利用 Vite 的 proxy 功能转发 `/api` 请求。*

### 生产构建 (Build for Production)

当前的 Fastify 后端（`src/web/server.ts`）已经被配置为**直接读取和提供前端的打包产物**。

1. 进入前端目录并执行构建：
   ```bash
   cd src/web/frontend
   npm run build
   ```
2. 构建成功后，Vite 会将产物（如 `app.js`, `styles.css`, `index.html`）输出到 `src/web/frontend/dist` 目录下。
3. 随后，当你启动后端服务时，它会自动在指定的端口（如 `http://127.0.0.1:3100`）提供这些编译好的前端页面。

#### 部署在自定义子路径 (Base Path)

如果你计划通过 Nginx 将服务部署在某个子路径下（例如 `example.com/capture/`），你可以通过设置 `VITE_BASE_PATH` 环境变量来构建前端：

```bash
cd src/web/frontend
VITE_BASE_PATH=/capture/ npm run build
```

并在 Nginx 中配置代理：
```nginx
location /capture/ {
    proxy_pass http://127.0.0.1:3100/; # 注意结尾的斜杠，用于剥离 /capture/ 前缀
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```


后端执行： 后端通过类似 tsx 这样的工具直接运行 TypeScript 代码，不需要提前打包。 比如：PORT=3100 node --import tsx src/web/server.ts （后端会监听在 3100 端口，前端的 API 请求需要打到这个端口上。）
