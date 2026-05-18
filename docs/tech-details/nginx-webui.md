# Nginx: Web UI under `/capture/`

线上如果这个服务不是独占域名根路径，而是挂在某个公共 `server` 的子路径下，例如：

```nginx
location /capture/ {
    proxy_pass http://127.0.0.1:3100/;
    proxy_max_temp_file_size 0;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

那么前端必须按 `/capture/` 这个 base path 构建。不要直接套用根路径 `/` 的 Nginx 静态文件配置，否则刷新前端路由、加载 `app.js`/`styles.css`、以及 API 请求路径都会不匹配。

## 前提

1. Fastify 监听本机端口，例如 `127.0.0.1:3100`。
2. Nginx 公共站点里只给这个项目分配 `/capture/` 这个 location。
3. 前端用 `VITE_BASE_PATH=/capture/` 构建，这样 Vite 产物里的资源路径、React Router 路径和前端 API 请求都会带上 `/capture/` 前缀。

## 构建前端

```bash
cd src/web/frontend
VITE_BASE_PATH=/capture/ npm run build
```

构建完成后，`dist/index.html` 中引用的脚本和样式会变成类似：

```html
<script type="module" crossorigin src="/capture/app.js"></script>
<link rel="stylesheet" crossorigin href="/capture/styles.css">
```

前端代码里的 API 请求也会基于 `import.meta.env.BASE_URL` 发到 `/capture/api/...`，再由 Nginx 剥离 `/capture/` 前缀后转发给 Fastify 的 `/api/...`。

## 启动后端

```bash
PORT=3100 node --import tsx src/web/server.ts
```

Fastify 仍然只需要认为自己运行在根路径下：

- 前端页面：`/`
- API：`/api/...`
- 健康检查：`/health`

外部访问路径由 Nginx 的 `/capture/` location 负责映射。

## Nginx 配置

把下面的 location 放到已有的公共 `server` 块里：

```nginx
server {
    listen 80;
    server_name your-host.example.com;

    # 其他业务的 location ...

    location /capture/api/ {
        proxy_pass http://127.0.0.1:3100/api/;
        proxy_max_temp_file_size 0;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /capture/health {
        proxy_pass http://127.0.0.1:3100/health;
        proxy_set_header Host $host;
    }

    location /capture/ {
        alias /home/bluewii/apps/kvault-web-capture/dist/src/web/frontend/dist/;
        try_files $uri $uri/ /capture/index.html;
    }
}
```

这个配置不是让 Nginx 直接读 `dist` 静态文件，而是把 `/capture/` 下的所有请求统一转给 Fastify。Fastify 会负责返回前端构建产物，并处理 API。

如果把 `proxy_pass` 写成没有尾斜杠的 `http://127.0.0.1:3100`，Nginx 会把 `/capture/...` 原样转发给后端，后端收到的路径会变成 `/capture/api/...`、`/capture/projects/1`，通常会导致 API 404 或 SPA fallback 不符合预期。

## 验证

配置完成后，确认这几件事：

1. 打开 `/capture/` 能看到前端页面。
2. 刷新一个前端路由，比如 `/capture/projects/1`，不会 404。
3. `/capture/app.js` 和 `/capture/styles.css` 能正常返回。
4. `/capture/api/auth/session` 会被正确转发到 Fastify 的 `/api/auth/session`。
5. `/capture/health` 会被正确转发到 Fastify 的 `/health`。

## 说明

- 子路径部署时，前端构建命令和 Nginx location 必须使用同一个前缀，例如都用 `/capture/`。
- `VITE_BASE_PATH` 需要保留开头和结尾的 `/`。
- 这个项目的前端 API 封装会用 `import.meta.env.BASE_URL` 拼接请求路径，所以 `/capture/api/...` 是预期行为。
- 如果以后这个服务独占一个域名根路径，才适合使用 `root .../dist`、`location /api/` 和 `location /` 的静态文件拆分配置。
