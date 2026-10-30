# neko-pi · apps/web（pi 社区 Web 前端接入）

## 这是什么

agegr/pi-web 的 vendored 副本（MIT），作为 neko-pi monorepo 的 `apps/web` 住户。
上游锚点：`agegr/pi-web@d128bae47`（subtree squash 导入，合并提交 94604cff9）。
后续同步：`git remote add piweb https://github.com/agegr/pi-web && git fetch piweb && git subtree pull --squash --prefix=apps/web piweb main`。

## 安装模型（重要，别用根目录装）

apps/web **不在根 workspaces 里**（根 package.json 的 workspaces 不含 `apps/*`）。
原因：Next 16 Turbopack 在"npm workspace 提升 + 根锁文件"的布局下解析必炸
（build-manifest/module not found 一串）。因此 apps/web 自带独立 `package-lock.json`，
在 `apps/web/` 目录内安装，形状与上游 standalone 完全一致。

七个 `@earendil-works/pi-*` 依赖改成了 `file:../../packages/<pkg>`，并用
`npm install --install-links=true` 装成**拷贝**（不是软链——Turbopack 对软链出
锁文件域的依赖解析不了）。拷贝来自本地 packages 的 dist，改了本地包后要重刷：

```bash
npm --prefix apps/web run sync:pi
```

## 启动（对准 neko-pi 的账本）

```bash
export PI_CODING_AGENT_DIR=~/.neko_pi
export PI_CODING_AGENT_SESSION_DIR=~/.neko_pi/sessions
npm --prefix apps/web run dev   # http://127.0.0.1:30141
```

不带这两个环境变量时读的是上游默认 `~/.pi/agent`（不存在，空列表属正常）。

## 已验证 / 待办

- 已验证：`/api/sessions` 列出 `~/.neko_pi/sessions` 全部会话（含名称/消息数/cwd），
  单会话详情按 `?cwd=` 返回消息流；本地芯（file: 拷贝自 packages/*）驱动。
- R2（待办）：persona/记忆/衣橱等 custom 消息类型的 web 渲染器（对齐 TUI renderers）。
- R3（待办）：记忆浏览器、衣橱管理、活动/着装侧栏。
- 注意：`npm install-scripts approve node-pty` 后需 `npm rebuild node-pty`，
  Linux 上 prebuild 会"SKIPPED (not Windows)"，直接 `cd node_modules/node-pty && npx node-gyp rebuild`。
