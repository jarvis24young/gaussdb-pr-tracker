# GaussDB ODBC PR Tracker

面向数据库驱动质量排查的 AI 辅助分析工具：自动拉取上游 `psqlodbc` 已合入 PR，点击 PR 后分析本地 GaussDB ODBC 仓库是否存在相同或相似问题，并输出风险等级、命中文件和修复建议。

## 这个项目适合解决什么问题

GaussDB ODBC / PGJDBC 等驱动与上游 PostgreSQL 生态代码高度相似。上游已合入的 bug fix PR 往往是非常高价值的质量线索。本工具把“人工浏览上游 PR、找本地相似代码、判断是否需要同步修复”做成可视化工作流，适合用于：

- 驱动质量排查和历史缺陷补漏
- 上游社区修复同步评估
- AI 辅助编程提效汇报演示
- 形成可复用的 PR 风险分析台账

## 功能

- 拉取 `postgresql-interfaces/psqlodbc` 已合入 PR
- 按上游变更文件名匹配本地 GaussDB ODBC 文件
- 调用 AI 分析上游修复与本地代码相似风险
- 展示 HIGH / MEDIUM / LOW / N/A 风险等级
- 缓存 PR 列表和分析结果，避免重复调用接口
- 支持 Anthropic 兼容接口、Poe 中转、MiniMax 原生 Chat Completions

## 推荐的内网 AI 配置

如果你的内网 MiniMax-M2.7 网关和 ClaudeCode 一样按 Anthropic 协议暴露，推荐使用 `anthropic` provider。配置结构如下：

```json
{
  "ANTHROPIC_AUTH_TOKEN": "sk-REPLACE_ME",
  "ANTHROPIC_BASE_URL": "http://your-intranet-ai-gateway:8888/",
  "ANTHROPIC_MODEL": "MiniMax-M2.7",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL": "MiniMax-M2.7",
  "ANTHROPIC_DEFAULT_SONNET_MODEL": "MiniMax-M2.7"
}
```

在本项目中等价的 `.env` 写法：

```env
AI_PROVIDER=anthropic
ANTHROPIC_AUTH_TOKEN=sk-REPLACE_ME
ANTHROPIC_BASE_URL=http://your-intranet-ai-gateway:8888/
ANTHROPIC_MODEL=MiniMax-M2.7
ANTHROPIC_DEFAULT_HAIKU_MODEL=MiniMax-M2.7
ANTHROPIC_DEFAULT_SONNET_MODEL=MiniMax-M2.7
GAUSSDB_ODBC_PATH=D:/GaussDB/openGauss-connector-odbc
```

`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL` 会被后端直接读取。也可以不写 `.env`，首次打开页面时在配置页填写。

## 从 ClaudeCode 自动导入

如果本机已经安装并配置过 ClaudeCode，工具会自动扫描常见配置位置：

- `~/.claude/settings.json`
- `~/.claude.json`
- `%APPDATA%\Claude\settings.json`
- `%LOCALAPPDATA%\claude-cli-nodejs\settings.json`
- `~/.cc-switch/backups/env-backup-*.json`

后端只识别以下 ClaudeCode 环境变量：

- `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_MODEL`
- `ANTHROPIC_DEFAULT_SONNET_MODEL`
- `ANTHROPIC_DEFAULT_HAIKU_MODEL`
- `ANTHROPIC_DEFAULT_OPUS_MODEL`
- `HTTP_PROXY` / `HTTPS_PROXY`

首次打开页面时可以点击“自动导入”，系统会把 ClaudeCode 的 Anthropic 兼容配置迁移到本项目的 `data/settings.json`。页面和接口只展示脱敏 token，例如 `sk-x...xxxx`，不会把完整密钥返回到前端列表或日志。

如果不点击导入，后端在未配置本项目 AI Key 时，也会优先把 ClaudeCode 配置作为默认 AI 配置读取。因此内网机器只要已有 ClaudeCode 配置，通常只需要配置 `GAUSSDB_ODBC_PATH` 或在页面填写本地 ODBC 仓库路径。

## 本机运行

```powershell
cd D:\GaussDB\pr-tracker
npm install
copy .env.example .env
notepad .env
npm start
```

打开：

```text
http://localhost:3000
```

如果 `3000` 端口已被占用，服务会自动尝试 `3001`、`3002` 等后续端口，控制台会打印实际访问地址。也可以手动指定：

```powershell
$env:PORT=3001
npm start
```

首次配置至少需要：

- 本地 GaussDB ODBC 仓库路径，例如 `D:\GaussDB\openGauss-connector-odbc`
- AI API Key
- AI Base URL 和模型名。内网 MiniMax-M2.7 走 Anthropic 兼容接口时，模型名填 `MiniMax-M2.7`

GitHub Token 可选。未配置时也能拉取公开 PR，但容易遇到 GitHub API 低频率限制。

## 迁移到另一台内网电脑

1. 在外网电脑把项目推到 GitHub。
2. 在内网电脑克隆仓库。
3. 运行 `npm install`。
4. 复制 `.env.example` 为 `.env`，填入内网 AI 网关和本地 ODBC 仓库路径。
5. 运行 `npm start`。

示例：

```powershell
git clone https://github.com/<your-account>/gaussdb-pr-tracker.git
cd gaussdb-pr-tracker
npm install
copy .env.example .env
notepad .env
npm start
```

## 不能提交到 GitHub 的文件

`.gitignore` 已经忽略以下内容：

- `node_modules/`
- `.env`
- `data/settings.json`
- `data/prs.json`
- `data/analysis_*.json`

这些文件可能包含 API Key、公司内部路径、缓存的上游分析结果或内部代码风险判断，不应提交到公开仓库。

## 常见配置

使用内网 Anthropic 兼容 MiniMax-M2.7：

```env
AI_PROVIDER=anthropic
ANTHROPIC_AUTH_TOKEN=sk-REPLACE_ME
ANTHROPIC_BASE_URL=http://your-intranet-ai-gateway:8888/
ANTHROPIC_MODEL=MiniMax-M2.7
```

使用 MiniMax 官方 Chat Completions：

```env
AI_PROVIDER=minimax
MINIMAX_API_KEY=REPLACE_ME
MINIMAX_MODEL=MiniMax-Text-01
MINIMAX_BASE_URL=https://api.minimax.chat/v1
```

调整 GitHub 拉取范围：

```env
GITHUB_PR_PAGES=5
```

每页 100 个 closed PR，后端会过滤出已 merge PR。

## 开发命令

```powershell
npm run dev
node --check server.js
```

前端是单文件页面：`public/index.html`。后端入口是 `server.js`。
