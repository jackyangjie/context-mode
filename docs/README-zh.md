# Context Mode（中文版）

> 原文见 [README.md](../README.md)。这是精简版，覆盖核心概念、安装、各平台配置、工具列表与常见问题。重点章节为 **OpenCode**。

**Context Mode 解决上下文问题的另一半。**

每次 MCP 工具调用都会把原始数据塞进你的上下文窗口。一次 Playwright 快照 56 KB，20 个 GitHub issue 59 KB，一条访问日志 45 KB。30 分钟后，你的上下文窗口 40% 已经没了。当 agent compact（压缩）对话腾空间时，它还会忘记正在编辑哪些文件、哪些任务进行中、你最后问了什么。Context Mode 同时解决四个问题：

1. **上下文节省** — 沙箱工具把原始数据挡在上下文之外。315 KB 变成 5.4 KB，节省 98%。
2. **会话连续性** — 每次文件编辑、git 操作、任务、错误、用户决策都记入 SQLite。对话 compact 时，context-mode 不会把这些数据倒回上下文，而是通过 FTS5 全文索引 + BM25 检索取回相关片段，模型从你上次停下的地方继续。
3. **以码代算（Think in Code）** — LLM 应当编程分析，而不是手动计算。不要读 50 个文件进上下文去数函数，而是让 agent 写个脚本做计数，`console.log()` 只输出结果。一个脚本替代 10 次工具调用，省 100 倍上下文。
4. **不强制文风** — context-mode 只管"数据放哪里"，不管"模型怎么说话"。简洁/详尽/格式由你的模型决定（或你在自己的 `CLAUDE.md` / `AGENTS.md` 里指定）。

## 安装

按安装复杂度分组。支持 hook 的平台自动做路由强制；不支持 hook 的平台需要一次性拷贝路由文件。

### Claude Code（推荐 — 全自动）

```bash
/plugin marketplace add mksglu/context-mode
/plugin install context-mode@context-mode
```

重启 Claude Code（或运行 `/reload-plugins`）。验证：

```
/context-mode:ctx-doctor
```

所有检查项应显示 `[x]`。

| Slash 命令 | 作用 |
|---|---|
| `/context-mode:ctx-stats` | 上下文节省统计 — 分工具、token、节省比例 |
| `/context-mode:ctx-doctor` | 诊断 — 运行时、hooks、FTS5、插件注册、版本 |
| `/context-mode:ctx-index` | 把本地文件/目录索引进 FTS5 知识库 |
| `/context-mode:ctx-search` | 搜索已索引内容 |
| `/context-mode:ctx-upgrade` | 拉最新代码、重建、迁移缓存、修 hooks |
| `/context-mode:ctx-purge` | 永久删除知识库中所有索引内容 |
| `/context-mode:ctx-insight` | 打开托管的 Insight 仪表盘（[context-mode.com/insight](https://context-mode.com/insight)） |

其他平台没有 slash 命令，在 chat 里直接说 `ctx stats`、`ctx doctor` 等，模型会自动调 MCP 工具。

### OpenCode（重点）

**前置条件：** Node.js ≥ 22.5（或 Bun），已安装 OpenCode。

**安装：**

1. 在项目根目录（或 `~/.config/opencode/opencode.json` 全局）的 `opencode.json` 中加入：

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["context-mode"]
   }
   ```

   `plugin` 条目会让 11 个 `ctx_*` 工具**原生注册**，并启用 hooks。OpenCode 在进程内调用 context-mode 的 TypeScript 插件，不存在 stdio MCP 子进程。

2. *（可选）* 拷贝路由文件，让模型理解哪些命令被拦截：

   ```bash
   cp node_modules/context-mode/configs/opencode/AGENTS.md AGENTS.md
   ```

   没有它，hooks 仍会强制路由，但模型不知道*为什么*某条命令被拒绝。

3. 重启 OpenCode。

**验证：** 让模型调 `ctx_stats`（或 `/ctx-stats`），应返回会话统计。注意：`/ctx-stats` 是 *prompt 模板*，不是直接工具调用 — OpenCode V2 把命令正文展开成 user prompt，再由模型去调底层 `ctx_stats` 工具。

**升级注意：** 如果你的配置同时有 `plugin: ["context-mode"]` 和 `mcp.context-mode`，OpenCode 会注册 **0 个** `ctx_*` 工具 — 插件路径会正确抑制 MCP 重复，但遗留的 MCP 条目会让 loader 困惑。运行 `context-mode upgrade` 删除遗留条目，其他 MCP 服务保留。v1.0.140+ 在这种情况下会向 stderr 输出诊断信息。

**Slash 命令（v1.0.170+）：** context-mode 附带 8 个 OpenCode 命令模板，位于 [`configs/opencode/commands/`](../configs/opencode/commands/)。OpenCode 适配器的 `configureAllHooks()` 会在 `context-mode upgrade` 时自动同步到 `~/.config/opencode/commands/`，无需手动拷贝：

| 命令 | 触发的工具 |
|---|---|
| `/ctx-stats` | `ctx_stats` |
| `/ctx-doctor` | `ctx_doctor` |
| `/ctx-upgrade` | `ctx_upgrade` |
| `/ctx-search <query>` | `ctx_search` |
| `/ctx-index <path>` | `ctx_index` |
| `/ctx-fetch <url>` | `ctx_fetch_and_index` |
| `/ctx-insight` | `ctx_insight` |
| `/ctx-purge` | `ctx_purge` |

三个执行类工具（`ctx_execute`、`ctx_execute_file`、`ctx_batch_execute`）没有命令模板，因为它们需要多行代码参数，不适合 prompt 模板。手动安装命令（不跑 `context-mode upgrade`）时：

```bash
mkdir -p ~/.config/opencode/commands
cp node_modules/@jackyangjie/context-mode/configs/opencode/commands/*.md ~/.config/opencode/commands/
```

**本地开发（加载未发布的构建）：**

OpenCode 没有 `.opencode-plugin/` 清单目录或其他清单约定 — 支持的两个安装面是：npm 包名在 `plugin`/`plugins` 配置数组里，以及 `.opencode/plugins/` 目录下的自动发现。该目录是加载本地构建的唯一途径：归档路径被拒绝，构建出的 tarball 不是合法目标。

```bash
npm ci && npm run build
mkdir -p .opencode/plugins
cp plugin.bundle.mjs .opencode/plugins/context-mode.js
cp -r hooks .opencode/plugins/hooks
opencode run --standalone --print-logs --log-level debug "say hi"
```

三个要点：

- **`hooks/` 是必须的，不是可选的。** `setup()` 相对 bundle 自身目录导入 `hooks/core/routing.mjs` 和 `hooks/auto-injection.mjs`。只拷 bundle 不拷 hooks，插件*加载成功*但路由强制静默关闭 — `ctx_*` 工具照常工作，但 `tool.execute.before` 永远不触发。loader 不会报这个；只表现为一条 plugin warning。
- **插件诊断只走 stderr。** V2 没有可用的日志 API 给插件：`console.log`、`process.stdout.write`、`ctx.app.log` 都不产生任何输出，`~/.local/share/opencode/log/opencode.log` 也不捕获插件输出。因此 warning 走 `process.stderr`，不受门控；`OPENCODE_DEBUG=1` 可开全量跟踪。
- **每次测试隔离配置。** OpenCode 从 `$OPENCODE_CONFIG_DIR` 或 `$HOME/.config/opencode` 解析配置，`XDG_CONFIG_HOME` 被忽略。用 `env -u OPENCODE_CONFIG_DIR HOME=/tmp/scratch ...` 让测试运行不碰真实 profile。注意：OpenCode V2 不在 npm 上 — `opencode-ai` 最高只到 V1 线 — 用 `curl -fsSL https://opencode.ai/v2/install | bash` 安装 V2。

OpenCode 也接受单数 `plugin` key（如上所示）；V2 会归一化为 `plugins`。两种写法都能用。

端到端 smoke：[`scripts/tier2-smoke/run-opencode-smoke.sh`](../scripts/tier2-smoke/run-opencode-smoke.sh) 在真实 V2 运行时上断言以上所有点：bundle 加载、无加载失败、无能力降级 warning。

**路由机制（OpenCode 特有）：**

hooks 通过 `tool.execute.before` 和 `tool.execute.after` 程序化强制路由。可选的 [`AGENTS.md`](../configs/opencode/AGENTS.md) 提供模型感知的路由说明。`experimental.session.compacting` 在对话 compact 时构建恢复快照。`experimental.chat.system.transform` 在会话开始时注入路由块和之前会话的快照，实现跨重启的会话连续性。`chat.message` 捕获用户 prompt 和决策（等价于 UserPromptSubmit）。

> **注意：** OpenCode 没有真正的 SessionStart hook（[#14808](https://github.com/sst/opencode/issues/14808)、[#5409](https://github.com/sst/opencode/issues/5409)）。插件用 `experimental.chat.system.transform` 作为替代 — 它同时向系统 prompt 注入路由块和恢复快照。用户 prompt 捕获用 `chat.message` 代替缺失的 UserPromptSubmit hook。AGENTS.md/CLAUDE.md/CONTEXT.md 规则在首次 hook 触发时按项目自动捕获。

完整配置：[`configs/opencode/opencode.json`](../configs/opencode/opencode.json) | [`configs/opencode/AGENTS.md`](../configs/opencode/AGENTS.md)

### 其他平台速览

**Gemini CLI / VS Code Copilot / JetBrains Copilot / GitHub Copilot CLI / Cursor / Codex CLI / Kimi Code / Qwen Code / Kiro / Zed / Antigravity IDE / Antigravity CLI (`agy`) / Pi / OMP / OpenClaw / KiloCode** — 各平台安装步骤与完整配置见英文 [README.md](../README.md) 对应章节。中文精简版聚焦 OpenCode，其他平台保持英文原文。

| 平台 | 安装方式 | 路由 |
|---|---|---|
| Claude Code | 插件市场 | 全自动 |
| Gemini CLI | MCP + 4 hooks（单配置文件） | 自动 |
| VS Code Copilot | MCP + 3 hooks（SessionStart） | 自动 |
| JetBrains Copilot | MCP + 3 hooks | 自动 |
| GitHub Copilot CLI | 插件（推荐）或手动 MCP + hooks | 自动 |
| Cursor | Marketplace（审核中）或手动 hooks + 路由文件 | 部分 |
| OpenCode | TypeScript 插件（in-process） | 自动（含 SessionStart 替代） |
| KiloCode | TypeScript 插件（共享 OpenCode 架构） | 自动 |
| OpenClaw / Pi Agent | 原生 gateway 插件 | 自动 |
| Codex CLI | 插件 + `[features].hooks` | 部分（PreToolUse 仅支持 deny） |
| Kimi Code | MCP + 6 hooks（TOML） | 完整 |
| Qwen Code | MCP + 5 hooks（JSON） | 完整 |
| Kiro | MCP + 2 hooks + KIRO.md | 部分 |
| Zed | 仅 MCP | 手动 |
| Antigravity IDE | 仅 MCP | 手动 |
| Antigravity CLI (`agy`) | 插件 | 部分（bounded PreToolUse） |
| Pi Coding Agent | 扩展 + 4 hooks | 自动 |
| OMP (Oh My Pi) | 插件 | 自动 |

## 工具列表

| 工具 | 作用 | 上下文节省 |
|---|---|---|
| `ctx_batch_execute` | 一次调用跑多条命令 + 多查询搜索。可选 `concurrency: 1-8` 用于 I/O 密集批处理 | 986 KB → 62 KB |
| `ctx_execute` | 沙箱里跑代码，12 种语言。只有 stdout 进上下文 | 56 KB → 299 B |
| `ctx_execute_file` | 把文件读进沙箱处理，原始内容永不离开 | 45 KB → 155 B |
| `ctx_index` | 把 markdown 分块存进 FTS5（BM25 排序） | 60 KB → 40 B |
| `ctx_search` | 一次调用多查询搜索已索引内容 | 按需取回 |
| `ctx_fetch_and_index` | 拉 URL、转 markdown、分块索引。TTL 内复用缓存（默认 24h，每次调用可覆盖 `ttl: <ms>`；`ttl: 0` 或 `force: true` 绕过）。`requests: [{url, source}, ...]` + `concurrency: 1-8` 并行多 URL | 60 KB → 40 B |
| `ctx_stats` | 显示上下文节省、调用次数、会话统计 | — |
| `ctx_doctor` | 诊断安装：运行时、hooks、FTS5、版本 | — |
| `ctx_upgrade` | 从 GitHub 升级到最新版本，重建、重配 hooks | — |
| `ctx_purge` | 永久删除知识库中所有索引内容 | — |

## 沙箱如何工作

每次 `ctx_execute` 调用都起一个独立子进程，有自己的进程边界。脚本之间不能互相访问内存或状态。子进程运行你的代码，捕获 stdout，**只有那个 stdout** 进入对话上下文。原始数据 — 日志文件、API 响应、快照 — 永不离开沙箱。

12 种语言运行时：JavaScript、TypeScript、Python、Shell、Ruby、Go、Rust、PHP、Perl、R、Elixir、C#。检测到 Bun 时自动用于 JS/TS（快 3-5 倍）。

认证 CLI 通过凭据透传工作 — `gh`、`aws`、`gcloud`、`kubectl`、`docker` 继承环境变量和配置路径，但不对对话暴露。

输出超过 5 KB 且提供了 `intent` 时，Context Mode 切换到 intent 驱动的过滤：把完整输出索引进知识库，搜索匹配 intent 的片段，只返回相关匹配，并附一段可搜索词表用于后续查询。

## 知识库如何工作

`ctx_index` 按标题分块 markdown（保留代码块完整），存入 **SQLite FTS5** 虚拟表。SQLite 后端运行时自动选择：Bun 用 `bun:sqlite`，Node.js ≥ 22.5 用 `node:sqlite`，其他用 `better-sqlite3`。搜索用 **BM25 排序**（基于词频、逆文档频率、文档长度归一化）。索引时应用 **Porter 词干提取**，"running"、"runs"、"ran" 匹配同一词干。标题和 heading 在 BM25 打分中权重 ×5。

`ctx_search` 返回围绕匹配查询词的片段 — 不是完整文档，不是近似，是实际索引内容的智能提取。`ctx_fetch_and_index` 把这套流程扩展到 URL：拉取、HTML 转 markdown、分块、索引。原始页面永不进入上下文。

### 排序：Reciprocal Rank Fusion（RRF）

搜索并行跑两种策略再用 RRF 合并：

- **Porter 词干** — FTS5 MATCH + porter 分词器。"caching" 匹配 "cached"、"caches"、"cach"。
- **Trigram 子串** — FTS5 trigram 分词器匹配部分字符串。"useEff" 找到 "useEffect"，"authenticat" 找到 "authentication"。

RRF 把两个排序列表合并为一个结果集，两个策略都排得高的文档会浮得更靠前。

### 邻近重排

多词查询有额外重排：查询词出现得近的片段被提升。"session continuity" 会把两个词相邻的段落排在隔几段才出现两个词的页面前面。

### 模糊纠错

Levenshtein 距离在重搜前纠正拼写错误。"kuberntes" → "kubernetes"，"autentication" → "authentication"。

### 智能片段

搜索结果用智能提取而非截断。不返回前 N 个字符（可能漏掉关键部分），而是找到查询词在内容中出现的位置，返回围绕这些匹配的窗口。

### TTL 缓存

索引内容持久化在每项目 SQLite 数据库（`~/.context-mode/content/`）。`ctx_fetch_and_index` 调用时若 URL 在 TTL 窗口内已被索引，则跳过拉取，直接搜索现有索引。

- **默认 TTL：** 24 小时。`ttl: <毫秒>` 可覆盖（PR #666）。稳定 spec 设长一点，频繁更新的 changelog 设短一点。
- **命中（TTL 内）：** 返回缓存提示（约 0.3 KB）而非重新拉取（48 KB+）。模型继续 `ctx_search`。
- **未命中（TTL 过期）：** 静默重拉，无需用户操作。
- **`ttl: 0` 或 `force: true`：** 绕过缓存，强制重拉。
- **14 天清理：** 启动时删除 14 天以上的 content 数据库和 sources。

### 渐进式限流

- **调用 1-3 次：** 正常结果（每查询 2 条）
- **调用 4-8 次：** 减少结果（每查询 1 条）+ 警告
- **调用 9+ 次：** 拦截 — 引导改用 `ctx_batch_execute`

## 会话连续性

上下文窗口填满时，agent compact 对话 — 丢旧消息腾空间。没有会话追踪的话，模型就忘了正在编辑哪些文件、哪些任务进行中、哪些错误已解决、你最后问了什么。

Context Mode 捕获会话期间所有有意义的事件，持久化到每项目 SQLite 数据库。对话 compact（或用 `--continue`、`--resume`、`/resume` 恢复）时，你的工作状态自动重建 — 模型从你最后的 prompt 继续，不需要你重述。

> 用 `/resume <picker>` 恢复非最新会话时也一样：SessionStart hook 检测到新 session id 的 live-event 表为空，回退到项目最近未消费的快照（`session_resume` 表）。picker 选对话，context-mode 重建之前的工作状态。

会话连续性需要 5 个 hooks 协作。各平台覆盖情况见英文 README 的 [Session Continuity](../README.md#session-continuity) 章节。OpenCode 和 KiloCode 通过 `experimental.chat.system.transform`（SessionStart 替代）+ `chat.message` 实现完整会话连续性。

### 捕获什么

每次工具调用都经过 hooks 提取结构化事件：

| 类别 | 事件 | 优先级 | 捕获方式 |
|---|---|---|---|
| **文件** | read, edit, write, glob, grep | 关键 (P1) | PostToolUse |
| **任务** | create, update, complete | 关键 (P1) | PostToolUse |
| **计划** | enter, exit, approved, rejected, 文件写入 | 关键 (P1) | PostToolUse |
| **规则** | CLAUDE.md / GEMINI.md / AGENTS.md 路径 + 内容 | 关键 (P1) | SessionStart |
| **用户 prompt** | 每条用户消息（用于 last-prompt 恢复） | 关键 (P1) | UserPromptSubmit |
| **决策** | 用户纠正、偏好（"用 X 不用 Y"） | 高 (P2) | UserPromptSubmit |
| **Git** | checkout, commit, merge, rebase, stash, push, pull, diff, status | 高 (P2) | PostToolUse |
| **错误** | 工具失败、非零退出码 | 高 (P2) | PostToolUse |
| **错误解决** | 跨连续工具调用的 错误→修复 配对 | 高 (P2) | PostToolUse |
| **约束** | 发现的限制（"不支持"、"权限拒绝"） | 高 (P2) | PostToolUse |
| **阻塞** | "blocked on"、"waiting for"、"depends on" — 跟踪直到解决 | 高 (P2) | UserPromptSubmit |
| **被拒方案** | 用户拒绝的工具调用（PreToolUse → PostToolUse 标记） | 高 (P2) | PreToolUse |
| **环境** | cwd 变化、venv、nvm、conda、worktree、包安装 | 高 (P2) | PostToolUse |
| **Agent 发现** | 完成的子 agent 结果（前 500 字符） | 高 (P2) | PostToolUse |
| **迭代循环** | 相同工具 3+ 次类似输入（重试检测） | 高 (P2) | PostToolUse |
| **延迟** | 超过 5s 的工具调用（工具名 + 耗时 ms） | 普通 (P3) | PreToolUse |
| **MCP 工具** | 所有 `mcp__*` 工具调用及计数 | 普通 (P3) | PostToolUse |
| **子 agent** | Agent 工具启动和完成 | 普通 (P3) | PostToolUse |
| **技能** | Slash 命令调用 | 普通 (P3) | PostToolUse |
| **外部引用** | URL、GitHub issue 引用（#123），去重 | 普通 (P3) | PostToolUse |
| **角色** | persona / 行为指令（"扮演资深工程师"） | 普通 (P3) | UserPromptSubmit |
| **意图** | 会话模式分类（investigate, implement, review） | 低 (P4) | UserPromptSubmit |
| **数据** | 用户粘贴的大数据引用（>1 KB） | 低 (P4) | UserPromptSubmit |

### compact 后会话如何存活

```
PreCompact 触发
  → 从 SQLite 读所有会话事件
  → 构建优先级分层的 XML 快照（≤2 KB）
  → 存入 session_resume 表

SessionStart 触发（source: "compact"）
  → 取回存好的快照
  → 写结构化事件文件 → 自动索引进 FTS5
  → 构建 15 类 Session Guide
  → 注入 <session_knowledge> 指令到上下文
  → 模型从最后一个用户 prompt 继续，携带完整工作状态
```

快照按优先级分层 — 若 2 KB 预算紧张，低优先级事件（意图、MCP 工具计数）先被丢弃，关键状态（活动文件、任务、规则、决策）永远保留。

compact 后模型收到一份 **Session Guide** — 带可操作章节的结构化叙述：Last Request、Tasks、Plans、Key Decisions、Files Modified、Unresolved Errors、Constraints、Blockers、Git、Project Rules、MCP Tools Used、Subagent Tasks、Skills Used、Rejected Approaches、External References、Environment、Data References、Session Intent、User Role。

详细事件数据也索引进 FTS5，可用 `ctx_search()` 按需取回。

## 实用命令

**在任意 AI 会话里** — 直接输入命令。LLM 自动调 MCP 工具：

```
ctx stats       → 上下文节省、调用次数、会话报告
ctx doctor      → 诊断运行时、hooks、FTS5、版本
ctx index       → 索引本地文件/目录供后续搜索
ctx search      → 搜索已索引内容
ctx upgrade     → 从 GitHub 更新、重建、重配 hooks
ctx purge       → 永久删除知识库中所有索引内容
ctx insight     → 在浏览器打开托管的 Insight 仪表盘
```

**从终端直接跑**（无需 AI 会话）：

```bash
context-mode doctor
context-mode index . --source project:my-app
context-mode search "authentication middleware" --source project:my-app
context-mode upgrade
context-mode insight          # 在浏览器打开托管的 Insight 仪表盘
bash scripts/ctx-debug.sh    # 完整诊断报告，用于 bug 反馈
```

在 Claude Code 上，slash 命令（`/ctx-stats` 等）也可用。在 OpenCode V2 上，v1.0.170+ 提供 8 个 `/ctx-*` 命令模板（见 [OpenCode 章节](#opencode重点)）。

## 基准数据

| 场景 | 原始 | 上下文 | 节省 |
|---|---|---|---|
| Playwright 快照 | 56.2 KB | 299 B | 99% |
| GitHub Issues（20 个） | 58.9 KB | 1.1 KB | 98% |
| 访问日志（500 请求） | 45.1 KB | 155 B | 100% |
| Context7 React 文档 | 5.9 KB | 261 B | 96% |
| 分析 CSV（500 行） | 85.5 KB | 222 B | 100% |
| Git log（153 提交） | 11.6 KB | 107 B | 99% |
| 测试输出（30 suite） | 6.0 KB | 337 B | 95% |
| 仓库研究（子 agent） | 986 KB | 62 KB | 94% |

完整会话：315 KB 原始输出变成 5.4 KB。会话时间从 ~30 分钟延长到 ~3 小时。

## 隐私与架构

Context Mode 不是 CLI 输出过滤器，也不是云分析仪表盘。它在 MCP 协议层工作 — 原始数据留在沙箱子进程中，永不进入上下文窗口。网页、API 响应、文件分析、Playwright 快照、日志文件 — 全部在完全隔离中处理。

**数据不出你的机器。** 无遥测、无云同步、无使用追踪、无需账号。你的代码、prompt、会话数据 — 全在本地。SQLite 数据库在你的家目录，用完就删。

这是有意的架构选择，不是功能缺失。上下文优化应在源头发生，而不是藏在按席位订阅的仪表盘后面。隐私优先是我们的哲学 — 每个设计决策都遵循它。

## 安全

Context Mode 强制执行你已在使用的那套权限规则 — 但扩展到 MCP 沙箱。如果你 block `sudo`，`ctx_execute`、`ctx_execute_file`、`ctx_batch_execute` 里也被 block。

**零配置。** 没配任何权限就不变。只有你加了规则才激活。

```json
{
  "permissions": {
    "deny": [
      "Bash(sudo *)",
      "Bash(rm -rf /*)",
      "Read(.env)",
      "Read(**/.env*)"
    ],
    "allow": [
      "Bash(git:*)",
      "Bash(npm:*)"
    ]
  }
}
```

加到项目的 `.claude/settings.json`（或 `~/.claude/settings.json` 全局）。所有平台都读 Claude Code 的设置格式 — 包括 Gemini CLI、VS Code Copilot、OpenCode。Codex CLI 的安全强制需要 `$CODEX_HOME/hooks.json` 或 `~/.codex/hooks.json` 里配好 Codex hooks。

模式是 `Tool(匹配什么)`，`*` 表示"任意"。用 `&&`、`;`、`|` 链接的命令会被拆开 — 每段单独检查。`echo hello && sudo rm -rf /tmp` 会被 block，因为 `sudo` 段匹配 deny 规则。**deny 永远胜过 allow**，更具体（项目级）规则覆盖全局。

### 项目边界封禁

`ctx_execute_file` 限制在项目根内。解析到工作区**外**的 `path` — 绝对路径如 `/home/user/secrets`、`../../` 穿越、指向项目外的本地 symlink — 会被拒绝并返回 `File access blocked` 错误。这是封禁 [#852](https://github.com/mksglu/context-mode/issues/852) 逃逸向量的手段（agent 被 host 沙箱拒了一个项目外读，就通过 MCP 沙箱重试；host 的 MCP 审批弹窗无法检查工具入参，所以逃逸对审批者不可见）。

此守卫**默认开启**，无需配置。要故意处理项目外文件（如 `/var/log` 下的共享日志），用**你已用于 host `Read` 工具的同一套 `permissions.allow` 规则**把它加回来 — 没有 context-mode 专属的环境变量：

```json
{
  "permissions": {
    "allow": ["Read(/var/log/**)"]
  }
}
```

context-mode 按 Claude Code 的方式精确遵守那条 allow 规则（从你的 `.claude/settings.json` / `~/.claude/settings.json` 读取），所以项目外授权只维护在一处、语义一致。

### 网络拉取加固

`ctx_fetch_and_index` 默认 block 危险 URL 目标：

- **协议：** 只允许 `http:` 和 `https:`（禁 `file://`、`gopher://`、`javascript:`、`data:`）。
- **云元数据 + 链路本地：** `169.254.0.0/16`（含 AWS/GCP/Azure IMDS 端点 `169.254.169.254`）硬 block，即使 hostname 解析到它（DNS 重绑定防御）。
- **多播 / 保留：** `224.0.0.0/4`、`0.0.0.0/8`、IPv6 `ff00::/8`、`fe80::/10` 被 block。
- **回环 + RFC1918**（`localhost`、`127.x`、`10.x`、`172.16-31.x`、`192.168.x`、IPv6 `::1`、`fc00::/7`）**默认允许**，本地 dev server + 内网拉取保持可用。

在托管/CI 环境想 block 私有目标也一并设：

```bash
export CTX_FETCH_STRICT=1
```

额外 block 回环 + RFC1918 + ULA。适合 context-mode 作为共享服务而非开发者本机运行时。

任何 `mcp__*` 工具调用的 `tool_input` 在持久化前也会被脱敏 — `hooks/posttooluse.mjs` 的正则匹配器把 `authorization`、`auth_token`、`access_token`、`refresh_token`、`bearer`、`token`、`secret`、`password`、`passwd`、`pwd`、`api_key` / `apikey` / `x_api_key`、`cookie` / `set-cookie`、`signature`、`private_key`、`client_secret`（不区分大小写、不区分连字符/下划线）掩码为 `[REDACTED]`，避免 MCP 参数里的凭据进会话数据库。

### 存储环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `CONTEXT_MODE_DIR` | 适配器默认（如 `~/.codex/context-mode`、`~/.claude/context-mode`） | 自 v1.0.147 起。context-mode 存储的绝对可写根。Sessions 和 stats 用 `<root>/sessions`；索引内容用 `<root>/content`。空值或纯空白视为未设（`ctx_doctor` 会显示）；非空值必须是绝对路径。`~` 不展开。 |

### 路由引导环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY` | `10` | PreToolUse hook 重新注入"大外部 MCP payload 请用 `ctx_execute` 包裹"的频次（以工具调用数计）。默认每 10 次匹配调用重注入一次，在 MCP 密集会话（50+ Jira/Slack/Notion 调用）中保持引导在模型近期窗口内。范围 `[1, 100]`；非法值回退 `10`。设 `1` 为"每次调用"（最激进 — 每次约加 250 token），设更大值降低频率。 |

## 构建前置条件（CentOS / RHEL / Alpine）

Context Mode 在 Node.js 上用 [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)，大多数平台有预编译原生二进制。glibc ≥ 2.31 的系统（Ubuntu 20.04+、Debian 11+、Fedora 34+、macOS、Windows）上 `npm install` 无需构建工具。

**Linux + Node.js ≥ 22.5：** Context Mode 自动用内置 `node:sqlite` 模块，完全消除原生 addon，规避 V8 `madvise(MADV_DONTNEED)` 破坏 addon `.got.plt` 段导致的 [偶发 SIGSEGV 崩溃](https://github.com/nodejs/node/issues/62515)。检测自动，无需配置。**Linux + Node < 22.5 不受支持**（[#564](https://github.com/mksglu/context-mode/issues/564)） — `npm install` 会失败并附修复指引。

**Bun 用户：** 无需原生编译。Context Mode 自动检测 Bun 并用 `bun:sqlite` 兼容适配器，`better-sqlite3` 及其构建依赖完全跳过。

旧 glibc（CentOS 7/8、RHEL 8、Debian 10）预编译二进制加载不了，better-sqlite3 **自动回退源码编译**（`prebuild-install || node-gyp rebuild --release`）。需要 C++20 编译器（GCC 10+）、Make、Python + setuptools。

**Windows / binding 自愈：** 安装后 `better_sqlite3.node` 缺失（如 `prebuild-install` 不在 cmd.exe PATH、缺 MSVC 工具链），postinstall 脚本和运行时 hook 会自动重新拉取预编译二进制并修复 binding — 无需手动 `npm rebuild`（#408）。

CentOS 8 / RHEL 8（glibc 2.28）：

```bash
dnf install -y gcc-toolset-10-gcc gcc-toolset-10-gcc-c++ make python3 python3-setuptools
scl enable gcc-toolset-10 'npm install -g context-mode'
```

CentOS 7 / RHEL 7（glibc 2.17）：

```bash
yum install -y centos-release-scl
yum install -y devtoolset-10-gcc devtoolset-10-gcc-c++ make python3
pip3 install setuptools
scl enable devtoolset-10 'npm install -g context-mode'
```

Alpine Linux：

Alpine 预编译二进制（musl）从 better-sqlite3 v12.8.0+ 开始可用。`^12.6.2` 依赖范围会让 `npm install` 解析到最新 12.x，Alpine 上无需构建工具即可工作。若锁定旧版本：

```bash
apk add build-base python3 py3-setuptools
npm install -g context-mode
```

## 常见问题

**Q: OpenCode 里 `/ctx-stats` 能用吗？**

A: v1.0.170+ 提供 8 个 OpenCode 命令模板（`/ctx-stats`、`/ctx-doctor`、`/ctx-upgrade`、`/ctx-search`、`/ctx-index`、`/ctx-fetch`、`/ctx-insight`、`/ctx-purge`）。这些是 *prompt 模板* 不是直接工具调用 — OpenCode 把命令正文展开成 user prompt，模型再调底层 `ctx_*` 工具。跑一次 `context-mode upgrade` 会自动同步到 `~/.config/opencode/commands/`。三个执行类工具（`ctx_execute`、`ctx_execute_file`、`ctx_batch_execute`）没有命令模板。

**Q: 我的配置同时有 `plugin: ["context-mode"]` 和 `mcp.context-mode`，OpenCode 注册了 0 个工具？**

A: 这是已知升级陷阱。插件路径会正确抑制 MCP 重复，但遗留的 MCP 条目让 loader 困惑。跑 `context-mode upgrade` 删除遗留条目，其他 MCP 服务保留。v1.0.140+ 会向 stderr 输出诊断。

**Q: OpenCode 的 SessionStart hook 呢？**

A: 上游没有 SessionStart hook（[#14808](https://github.com/sst/opencode/issues/14808)、[#5409](https://github.com/sst/opencode/issues/5409)）。插件用 `experimental.chat.system.transform` 作为替代 — 它向系统 prompt 注入路由块 + 之前会话的恢复快照，实现跨重启的会话连续性。用户 prompt 捕获用 `chat.message` 代替。

**Q: 只拷 `plugin.bundle.mjs` 不拷 `hooks/` 会怎样？**

A: 插件*加载成功*，但路由强制静默关闭。`ctx_*` 工具照常工作，但 `tool.execute.before` 永远不触发。loader 不会报这个，只表现为一条 plugin warning。诊断只走 stderr — `OPENCODE_DEBUG=1` 可看到。

**Q: 本地开发加载未发布的构建怎么搞？**

A: OpenCode 没有 `.opencode-plugin/` 清单目录。两个安装面是：npm 包名在 `plugin`/`plugins` 配置数组里，以及 `.opencode/plugins/` 目录自动发现。加载本地构建只能走 `.opencode/plugins/`（归档路径被拒绝）。把 `plugin.bundle.mjs` 拷成 `.opencode/plugins/context-mode.js`，**`hooks/` 必须一并拷过去**。V2 不在 npm 上（`opencode-ai` 最高只到 V1 线），用 `curl -fsSL https://opencode.ai/v2/install | bash` 安装。

**Q: 数据会上传到云吗？**

A: 不会。无遥测、无云同步、无使用追踪、无需账号。SQLite 数据库在你的家目录。

**Q: 哪些工具没有命令模板？**

A: `ctx_execute`、`ctx_execute_file`、`ctx_batch_execute` 三个执行类工具需要多行代码参数，不适合 prompt 模板。直接在 chat 里说"用 ctx_execute 跑一段 Python 统计 ...",模型会调用。

## 贡献

见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

```bash
git clone https://github.com/mksglu/context-mode.git
cd context-mode && npm install && npm test
```

## 许可

[Elastic License 2.0](../LICENSE)（source-available）。可用、可 fork、可修改、可分发。不能做两件事：把它作为托管/管理服务提供，或删除许可声明。选 ELv2 而非 MIT 是因为 MIT 允许把代码重新打包成竞争性的闭源 SaaS — ELv2 防止这种情况同时保持源码对所有人可用。
