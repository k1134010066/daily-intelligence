# 每日情报 MVP

这是基于 `Design.md` 的可运行 Web 首版：保留深色仪表盘、三平台筛选、重点内容指标、摘要审核和原文查看路径。

## 启动

```bash
npm start
```

浏览器打开 `http://localhost:4173`。

## macOS 后台运行

项目提供了 macOS `launchd` 用户服务配置。它会在当前用户登录后自动启动服务，并在服务异常退出时自动重启；关闭 Claude/Codex 或浏览器不会影响服务。

安装并启动：

```bash
mkdir -p "$HOME/Library/LaunchAgents"
cp launchd/com.xiaohongshu-mcp.plist "$HOME/Library/LaunchAgents/"
cp launchd/com.daily-intelligence.mvp.plist "$HOME/Library/LaunchAgents/"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.xiaohongshu-mcp.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.daily-intelligence.mvp.plist"
launchctl kickstart -k "gui/$(id -u)/com.xiaohongshu-mcp"
launchctl kickstart -k "gui/$(id -u)/com.daily-intelligence.mvp"
```

查看状态和日志：

```bash
launchctl print "gui/$(id -u)/com.daily-intelligence.mvp"
launchctl print "gui/$(id -u)/com.xiaohongshu-mcp"
tail -f runtime/logs/server.stdout.log runtime/logs/server.stderr.log
```

停止并卸载：

```bash
launchctl bootout "gui/$(id -u)/com.daily-intelligence.mvp"
launchctl bootout "gui/$(id -u)/com.xiaohongshu-mcp"
rm "$HOME/Library/LaunchAgents/com.daily-intelligence.mvp.plist"
rm "$HOME/Library/LaunchAgents/com.xiaohongshu-mcp.plist"
```

小红书收集后端使用本机 `xiaohongshu-mcp` 服务；服务和小红书登录状态需要保持可用。

## 已实现

- 今日总览：新增趋势、待审核、今日已推送三项摘要。
- 平台筛选：全部、小红书、抖音、视频号；小红书搜索可使用 MCP，抖音及 MediaCrawler 相关能力保留。
- 搜索：按标题、摘要、标签、平台筛选当前列表。
- 审核：审核通过后更新状态，并返回企业微信、飞书、小程序三个渠道的队列结果。
- 重点内容：封面、标题、副标题/摘要、标签、平台、时间、点赞、收藏、评论；点击行查看详情并打开原文。
- 小红书 MCP 收集：通过 `POST /api/collector/sync` 或自动调度调用 `search_feeds`，统一转换为重点内容结构。
- MediaCrawler 兼容：仅为仍未替换的平台（当前为抖音）保留原有配置、Python runner、CDP 授权监听、JSON/JSONL 文件读取、原文封面服务和 `/api/crawler/*` 旧接口；小红书不会再从旧 MediaCrawler 文件启动恢复数据。
- 关键词配置：网页手动维护统一的关注关键词、采集平台和运行时段。
- 自动调度：默认每天 07:00、12:00、18:00（Asia/Shanghai）采集已勾选平台；小红书固定使用本机 `xiaohongshu-mcp-v2.5.0`，其他平台使用各自已接入的采集器；设置页可立即手动运行一次。
- Agent 分析：每轮采集完成后自动执行 `agentPrompt`，生成趋势列表与待审核摘要；没有配置 `OPENAI_BASE_URL` / `OPENAI_API_KEY` 时自动使用本地规则分析，不会让调度链路失效。
- 图片兜底：平台 CDN 图片不可访问时，页面使用本地封面占位，避免出现空白图片区域。

## 接入本地爬虫

### 跨机器部署路径配置

代码不再依赖固定的 macOS 用户目录。部署到服务器时，通过环境变量指定采集器和运行目录；示例见 `config/production.example.env`：

```bash
MEDIACRAWLER_ROOT=/opt/daily-intelligence/vendor/MediaCrawler
MEDIACRAWLER_PYTHON=/opt/daily-intelligence/vendor/MediaCrawler/.venv/bin/python
MEDIACRAWLER_RUNNER_SCRIPT=/opt/daily-intelligence/scripts/mediacrawler_runner.py
COLLECTION_DATA_PATH=/opt/daily-intelligence/runtime/mediacrawler
TWITTER_CLI_PATH=/usr/local/bin/twitter
XHS_MCP_URL=http://127.0.0.1:18060/mcp
```

服务器上的 `MediaCrawler`、`xiaohongshu-mcp` 和 `twitter` CLI 需要分别安装；不要上传本机 `cookies.json`，也不要把真实 Token 写入 Git 仓库。

公网部署必须配置管理员密码：

```bash
ADMIN_PASSWORD=replace-with-a-long-random-password
ADMIN_SESSION_TTL_MINUTES=480
```

配置后，采集设置、Agent、审核、内容和登录二维码接口都会要求管理员登录；未配置 `ADMIN_PASSWORD` 时仅作为本机开发模式运行。

### HTTPS 反向代理

生产环境建议让 Node 只监听 `127.0.0.1:4173`，由 Caddy 对外提供 HTTPS。示例配置在 `deploy/Caddyfile.example`，Caddy 会根据域名自动申请和续期证书：

```text
浏览器 → HTTPS / Caddy → 127.0.0.1:4173 / Node.js
```

部署前需要先把域名的 DNS A/AAAA 记录指向服务器，并将示例中的域名替换为你的真实域名。Node 的 systemd 启动模板见 `deploy/daily-intelligence.service.example`。

部署同步项目时，只同步代码、`public/`、`scripts/`、`config/keyword-catalog.json` 和示例配置；不要同步以下内容：

```text
cookies.json
runtime/
.env*
config/*.env（保留 production.example.env）
```

项目根目录的 `.gitignore` 已加入这些保护规则。它不会删除本机文件，只防止后续误提交或误同步。

### 服务器登录状态

部署后，采集使用服务器自己的登录状态，不复用本机浏览器 Cookie：

- 小红书：在服务器启动 `xiaohongshu-mcp`，通过 SSH 端口转发访问网站，在“采集设置”中扫码登录；登录状态由服务器上的 MCP 保存。
- 推特：优先在服务器环境变量中配置 `TWITTER_AUTH_TOKEN` 和 `TWITTER_CT0`；Twitter CLI 会继承这两个变量，不需要读取本机 Chrome Cookie。
- 服务器登录完成后，不要把二维码、Cookie、`auth_token` 或 `ct0` 写入项目文件、前端代码或 Git 仓库。

小红书二维码接口当前只允许本机请求。服务器尚未完成网页管理员登录前，可使用 SSH 隧道访问：

```bash
ssh -N -L 4173:127.0.0.1:4173 user@your-server
```

然后在本机打开 `http://127.0.0.1:4173` 扫码，二维码登录实际发生在服务器上的小红书 MCP。

启动时设置一个只在本机使用的 token：

```bash
CRAWLER_INGEST_TOKEN=replace-me npm start
```

收集后端默认连接 `http://127.0.0.1:18060/mcp`，可通过 `XHS_MCP_URL` 覆盖。每个关键词调用一次 MCP 的 `search_feeds`，去重后写入内存中的重点内容列表；笔记原文链接会保留 `xsec_token`。

MediaCrawler 的根目录、运行脚本、保存目录和旧采集参数仍由 `config/mediacrawler.local.json` 与 `config/automation.json` 控制，但在当前配置下只用于抖音。`collector` 为 `xiaohongshu-mcp` 时，小红书由本机 v2.5.0 MCP 服务负责搜索；只有显式设置为 `mediacrawler` 才会恢复小红书的旧采集路径。

Agent 配置也在 `config/automation.json`：修改 `agentPrompt` 即可改变分析任务；`agentProvider` 可设为 `local` 强制使用本地规则，设为 `auto` 时会在存在 OpenAI 兼容接口环境变量时使用远程 Agent，否则回退本地规则。远程 Agent 使用 `OPENAI_BASE_URL`、`OPENAI_API_KEY` 和 `agentModel`。每轮自动任务顺序是：小红书 MCP 搜索及/或 MediaCrawler 采集 → 统一字段转换 → Agent 分析 → 更新趋势与待审核摘要。

当前收集后端依赖本机小红书 MCP：

```text
http://127.0.0.1:18060/mcp
```

点击页面右上角“同步爬虫结果”会立即执行当前收集配置。运行前请确认 `xiaohongshu-mcp` 已启动且账号已登录；MediaCrawler 路径仍可单独通过旧 `/api/crawler/sync` 接口同步。

## 当前边界

推送和飞书多维表格已经预留适配位置，但本地没有配置企业微信、飞书或小程序凭证，因此当前只返回队列状态，不会向外部账号发送消息。实际接入前需要补充目标账号、Webhook/App 凭证、飞书表格字段映射和每日最终摘要生成任务。
