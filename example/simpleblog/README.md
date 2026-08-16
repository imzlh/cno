# Quiet line

一个使用 Fresh 2、Preact 和 Deno KV 构建的轻量博客。首页、归档、文章详情和编辑后台都由服务端渲染；后台支持新建、编辑、草稿、发布、精选和删除。

## 本地运行

在 PowerShell 中设置后台令牌并启动开发服务器：

```powershell
$env:QUIETLINE_ADMIN_TOKEN="replace-with-a-strong-secret"
deno task dev
```

打开 `http://localhost:5173`，后台位于 `http://localhost:5173/admin`。首次读取时会自动把示例文章写入项目目录下的 `.quietline-kv.sqlite3`。

站点自动提供 `/feed.xml`、`/sitemap.xml`、`/robots.txt` 和 `/api/health`，内容会随 Deno KV 中的已发布文章更新。

生产构建与启动：

```powershell
deno task build
$env:QUIETLINE_ADMIN_TOKEN="replace-with-a-strong-secret"
deno task start
```

默认数据文件可通过 `QUIETLINE_KV_PATH` 修改。写接口同时接受后台表单中的令牌，或 `x-admin-token` 请求头。未配置令牌时所有持久化写入都会返回 `503`。

## 检查

```powershell
deno fmt --check routes data assets components
deno lint routes data assets components
deno check routes/index.tsx routes/archive.tsx routes/article/[slug].tsx routes/admin.tsx routes/api/posts.ts routes/api/subscribe.ts data/posts.ts
deno task build
```
