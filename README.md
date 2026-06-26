# cc-in-codex

> 中文主文档。English README: [README.en.md](./README.en.md)

`cc-in-codex` 是一个本地 MCP server，让 Codex 可以像人类一样使用你本机已经登录好的 Claude Code，并把 Claude Code 变成一个持续陪伴当前项目的实现助手。

这个工具的目标不是再做一个一次性代码生成器，而是建立一种更高效的双 Agent 工作模式：

- 你只和 Codex 对话。
- Codex 负责思考、拆解、判断、审查和最终汇总。
- Claude Code 负责读仓库、改代码、跑测试、重构、执行命令和使用它自己的 subagent/技能体系。
- 同一个项目目录绑定同一个 Claude Code companion，上下文可以持续积累，也可以从 Claude Code CLI 里恢复。

## 目录

- [为什么需要它](#为什么需要它)
- [核心能力](#核心能力)
- [工作模型](#工作模型)
- [两种后端：SDK 与 TUI](#两种后端sdk-与-tui)
- [系统要求](#系统要求)
- [安装与构建](#安装与构建)
- [在 Codex 中注册 MCP](#在-codex-中注册-mcp)
- [快速开始：新项目](#快速开始新项目)
- [继续已有 Claude Code 项目](#继续已有-claude-code-项目)
- [可见 TUI 模式](#可见-tui-模式)
- [Codex 应该如何调用](#codex-应该如何调用)
- [MCP 工具说明](#mcp-工具说明)
- [上下文、resume 与 compact](#上下文resume-与-compact)
- [状态栏与上下文压力监控](#状态栏与上下文压力监控)
- [安全与权限模型](#安全与权限模型)
- [本地状态与隐私](#本地状态与隐私)
- [CLI 用法](#cli-用法)
- [开发与发布前检查](#开发与发布前检查)
- [常见问题](#常见问题)
- [当前边界](#当前边界)
- [推荐工作流](#推荐工作流)
- [开源协议](#开源协议)

## 为什么需要它

Codex 和 Claude Code 的强项不完全一样。

在很多真实工程任务中，一个自然的分工是：

- Codex 更适合做科学式思考、方案权衡、任务拆解、风险判断、代码审查和最终决策。
- Claude Code 更适合做本地工程执行：读大量文件、改代码、跑测试、处理工具链、使用 subagent、持续推进实现。

如果每次都让 Codex 给 Claude Code 发一个孤立任务，效果会很差：

- Claude Code 上下文不连续。
- Codex 不知道 Claude Code 之前做过什么。
- 用户需要同时管理两个 Agent。
- prompt 容易重复、变长、污染上下文。
- 出问题时缺少及时监控和止损。

`cc-in-codex` 解决的是这个交互问题。它让 Codex 通过 MCP 管理一个本地、持久、可恢复的 Claude Code companion。用户只需要和 Codex 对话，Codex 会在合适的时候调用 Claude Code，并负责审查 Claude Code 的结果。

## 核心能力

`cc-in-codex` 当前提供：

- 使用本机 `claude` 可执行文件和本地 Claude Code 登录态，包括 Claude Max 账号。
- 不要求新的 Anthropic API key。
- 每个 `cwd` 维护一个持久 Claude Code companion。
- 支持 SDK 后端，用于 Codex 后台委派代码任务并等待结果。
- 支持 TUI 后端，在 `tmux` 里运行原生 Claude Code 全屏 CLI，用户可以实时观看或接管。
- 支持从已有 Claude Code 会话恢复：
  - SDK：绑定明确的 `sessionId`。
  - TUI：`claude --resume <session-id>` 或 `claude --continue`。
- 支持 raw TUI 输入，例如 `/status`、`/help`、`/clear`、`Escape`、`C-c`。
- 支持 Claude Code statusLine，读取真实 `context_window` 信息，用于判断是否适合 compact。
- 支持 `companion_tui_compact_check` 和 `companion_tui_compact`，让 compact 发生在合理节点，而不是机械触发。
- 支持 stop-loss：SDK 后端有运行时间和 stall timeout；TUI 后端可以被 Codex 或用户显式打断。
- 支持项目初始化：生成共享的 `AGENTS.md` 和 `CLAUDE.md`，让 Codex 与 Claude Code 读取同一份项目指令。
- 状态只存储在本地 `~/.cc-in-codex/`。

## 工作模型

`cc-in-codex` 的基本思想是：

```text
User
  |
  v
Codex
  |
  | MCP tools
  v
cc-in-codex
  |
  | local claude executable
  v
Claude Code companion
  |
  v
Project files / tests / tools
```

职责边界：

- 用户只和 Codex 对话。
- Codex 是 lead agent，负责判断什么时候需要 Claude Code、给出高质量任务 prompt、监控执行、审查结果。
- Claude Code 是 implementation companion，负责在本地项目里执行工程任务。
- `cc-in-codex` 是连接层，不替代 Codex，也不替代 Claude Code。

这意味着：Claude Code 的输出不是最终答案，Codex 仍然需要 review 和 synthesis。

## 两种后端：SDK 与 TUI

### SDK 后端

SDK 是默认后端，适合日常后台委派。

特点：

- Codex 调用 `companion_send` 或 `companion_start`。
- Claude Code 在 SDK/print 风格下完成任务。
- Codex 可以拿到结构化结果、事件、成本、turn 数、session id。
- 适合代码修改、测试、审计、小型重构、只读分析。

推荐场景：

- “让 Claude Code 改这个 bug，然后跑测试。”
- “让 Claude Code 读这几个模块，给我一个实现报告。”
- “让 Claude Code 执行一组明确的工程任务。”

### TUI 后端

TUI 后端会在 `tmux` 中打开原生 Claude Code CLI。

特点：

- 你可以在 Codex 右侧终端 attach 进去，看到 Claude Code 的原生 ASCII/TUI 界面。
- Codex 可以向这个 TUI 发送任务 prompt。
- 你也可以直接在 TUI 里打字、发 slash command、接管会话。
- TUI 后端不尝试从全屏终端里“猜测任务完成”，它更像可见的远程控制。

推荐场景：

- 你想实时观看 Claude Code 在干什么。
- 任务复杂，想保留人工接管能力。
- 你想继续已有 Claude Code CLI 的体验。
- 你要使用 Claude Code 自己的 TUI 能力、slash command、resume picker 或 subagent 工作流。

### 怎么选

默认用 SDK。需要“看见 Claude Code 原生界面”或“人类随时接管”时用 TUI。

| 场景 | 推荐 |
| --- | --- |
| 后台执行明确任务 | SDK |
| 需要 Codex 等待结果并审查 | SDK |
| 需要实时观看 Claude Code UI | TUI |
| 需要手动输入 slash command | TUI |
| 继续最近的 Claude Code CLI 对话 | TUI `--continue` |
| 精确绑定已有 session id | SDK 或 TUI |

## 系统要求

- Node.js 22 或更新版本。
- 本机已安装并登录 Claude Code，`claude --version` 可运行。
- Codex 支持 MCP server。
- TUI 模式需要 `tmux`。

macOS 安装 `tmux`：

```bash
brew install tmux
```

确认依赖：

```bash
node --version
claude --version
tmux -V
```

## 安装与构建

从源码安装：

```bash
npm install
npm run build
```

开发检查：

```bash
npm run typecheck
npm run build
npm run smoke
```

`npm run smoke` 不会启动真实 Claude 任务，也不会创建 TUI 会话。它只检查：

- MCP server 能正常启动并暴露关键工具。
- SDK resume 绑定逻辑可用。
- CLI help 包含 resume/continue 选项。

## 在 Codex 中注册 MCP

把构建后的 server 注册到 Codex：

```bash
codex mcp add cc-in-codex -- node /absolute/path/to/cc-in-codex/dist/index.js
```

查看配置：

```bash
codex mcp get cc-in-codex
```

如果 `claude` 不在 PATH，可以指定：

```bash
CC_IN_CODEX_CLAUDE_PATH=/absolute/path/to/claude
```

注册后重启 Codex，确保工具列表刷新。重启后 Codex 应该能看到 `companion_send`、`companion_resume`、`companion_tui_open`、`companion_tui_resume` 等工具。

## 快速开始：新项目

在一个全新项目中，推荐这样用：

1. 用户告诉 Codex：“这个项目使用 cc-in-codex。”
2. Codex 调用 `companion_init_project`。
3. `cc-in-codex` 创建：
   - `AGENTS.md`
   - `CLAUDE.md`
4. Codex 后续用 `companion_send` 给 Claude Code 分配任务。
5. 当用户想看实时 UI 时，Codex 调用 `companion_tui_open`，用户在右侧终端 attach。

初始化项目：

```json
{
  "cwd": "/absolute/path/to/project"
}
```

生成的 `AGENTS.md` 是 Codex 和 Claude Code 的共享项目记忆。`CLAUDE.md` 会提示 Claude Code 先读取 `AGENTS.md`。

这样做的原因是：项目指令应该写在仓库里，而不是每一轮 prompt 里重复粘贴。

## 继续已有 Claude Code 项目

如果一个项目本来已经用过 Claude Code，你通常不希望丢掉已有会话上下文。`cc-in-codex` 支持两种恢复方式。

### 精确恢复 session id

如果你知道 Claude Code 的 session id，可以让 SDK 后端绑定它：

```json
{
  "cwd": "/absolute/path/to/project",
  "backend": "sdk",
  "sessionId": "00000000-0000-0000-0000-000000000000"
}
```

之后 Codex 再用 `companion_send`，就会 resume 这个 Claude Code 会话。

TUI 也可以精确恢复：

```json
{
  "cwd": "/absolute/path/to/project",
  "sessionId": "00000000-0000-0000-0000-000000000000"
}
```

这等价于在该项目里启动：

```bash
claude --resume 00000000-0000-0000-0000-000000000000
```

### 继续当前目录最近一次 Claude Code 对话

如果你不知道 session id，但想继续该项目最近的 Claude Code 对话，使用 TUI：

```json
{
  "cwd": "/absolute/path/to/project",
  "continueLatest": true
}
```

这等价于：

```bash
claude --continue
```

注意：SDK 后端需要明确 session id。`--continue` 是 Claude Code CLI/TUI 的语义，当前由 TUI 后端负责。

### 避免误替换正在看的 TUI

如果该项目已经有一个 cc-in-codex TUI pane 在运行，resume 默认不会偷偷替换它。你会得到明确错误，提示已有 tmux session。

如果你明确想关闭现有 pane 并启动恢复后的会话，传入：

```json
{
  "cwd": "/absolute/path/to/project",
  "continueLatest": true,
  "replaceTui": true
}
```

这个保护很重要：用户右侧终端看到的 Claude Code 会话，必须和 Codex 正在操作的会话一致。

## 可见 TUI 模式

打开 TUI：

```json
{
  "cwd": "/absolute/path/to/project"
}
```

工具返回类似：

```bash
tmux attach -t ccic-my-project-abc123def0
```

在 Codex 右侧终端运行这条命令，就能看到原生 Claude Code TUI。

常用 tmux 操作：

```text
Ctrl-b d      detach，退出观察但不关闭 Claude Code
Ctrl-b [      进入 scrollback
q             退出 scrollback
```

Codex 给 TUI 发任务时，会把 prompt 粘贴到 Claude Code CLI 并按 Enter。用户会在 TUI 中实时看到输入、输出、工具调用和 Claude Code 的交互状态。

### TUI prompt 分层

TUI 后端有一个重要 UX 设计：bootstrap 与 task 分离。

第一次向一个新 TUI pane 发送任务时，`cc-in-codex` 会发送一段 bootstrap，建立 companion 角色：

- Codex 是 lead agent。
- Claude Code 是执行 companion。
- 当前工作目录。
- 权限策略。
- 汇报格式。
- 不要直接问用户，向 Codex 汇报 blocker。

后续每轮任务只发送：

```text
Task: ...
```

这样避免每轮都把大量身份说明塞进 Claude Code 上下文，同时新 pane 仍然能被正确初始化。

当执行 `/clear` 或 `/compact` 后，下一轮会自动重新 bootstrap。

### Raw 输入

有些输入不应该被 cc-in-codex 包装成任务，例如 slash command 或控制键。使用 `companion_tui_raw`：

```json
{
  "cwd": "/absolute/path/to/project",
  "text": "/status"
}
```

发送 Escape：

```json
{
  "cwd": "/absolute/path/to/project",
  "keys": ["Escape"],
  "enter": false
}
```

发送 Ctrl-C：

```json
{
  "cwd": "/absolute/path/to/project",
  "keys": ["C-c"],
  "enter": false
}
```

Raw 输入适合：

- `/status`
- `/help`
- `/clear`
- `/compact`
- `Escape`
- `C-c`
- 用户明确要求原样输入的内容

## Codex 应该如何调用

这个 MCP server 是给 Codex 用的。理想行为是：

- 用户说“用 Claude Code 做一下这个实现”，Codex 调用 `companion_send`。
- 用户说“打开可见 TUI”，Codex 调用 `companion_tui_open`。
- 用户说“继续我原来 Claude Code 的上下文”，Codex 优先判断是否有 session id；没有则用 TUI `continueLatest`。
- 用户说“看一下右边 Claude Code 在干嘛”，Codex 调用 `companion_tui_screen`。
- 用户说“停掉它”，Codex 调用 `companion_cancel` 或 TUI raw `C-c`。
- 用户说“现在是否该 compact”，Codex 先调用 `companion_tui_compact_check`，再决定是否 `companion_tui_compact`。

Codex 不应该：

- 把整个仓库摘要粘贴给 Claude Code。
- 每轮重复长篇身份说明。
- 在没有检查 checkpoint 的情况下随便 compact。
- 盲目信任 Claude Code 的输出而不 review。
- 在用户正在观察 TUI 时静默替换为另一个会话。

## MCP 工具说明

### 通用工具

| 工具 | 用途 |
| --- | --- |
| `companion_open` | 打开或恢复当前项目 companion，不发送任务 |
| `companion_resume` | 绑定已有 Claude Code session，或触发 TUI continue/resume |
| `companion_send` | 发送短任务并等待完成 |
| `companion_start` | 启动长任务，立即返回 run id |
| `companion_recent` | 查看最近事件 |
| `companion_status` | 查看当前 companion 状态 |
| `companion_result` | 查看最近结果和 resume 命令 |
| `companion_cancel` | 停止当前运行 |
| `companion_reset` | 忘记该 cwd 的 companion 绑定 |
| `companion_init_project` | 创建共享项目指令文件 |

### TUI 工具

| 工具 | 用途 |
| --- | --- |
| `companion_tui_open` | 创建或恢复可见 Claude Code TUI |
| `companion_tui_resume` | 用 `--resume` 或 `--continue` 打开可见 TUI |
| `companion_tui_send` | 向可见 TUI 发送任务 |
| `companion_tui_raw` | 向 TUI 发送原始文本或按键 |
| `companion_tui_screen` | 捕获 TUI 当前屏幕文本 |
| `companion_tui_compact_check` | 判断当前是否适合 compact |
| `companion_tui_compact` | 发送带保护说明的 `/compact` |

## 上下文、resume 与 compact

### Claude Code 自己会保留上下文吗

会。Claude Code 会在本地保存可恢复的 session。`cc-in-codex` 不需要复制 Claude Code 的全部对话历史。

但有一个边界必须讲清楚：

Codex 不能天然看到 Claude Code 的完整历史。Codex 能看到的内容来自：

- MCP 工具返回的结构化结果。
- `companion_recent` 保存的事件摘要。
- `companion_tui_screen` 捕获的当前 TUI 屏幕。
- `AGENTS.md` / `CLAUDE.md` / 项目文件。
- statusLine 快照。

所以 `cc-in-codex` 的设计是：

- Claude Code 的完整上下文由 Claude Code 自己维护。
- Codex 的当前判断依赖 MCP 暴露出来的高信号状态。
- 重要项目知识应该进入 `AGENTS.md`，而不是只存在某次终端滚动记录里。

### resume 的目的

resume 不是为了把所有历史复制给 Codex，而是为了让 Claude Code 自己继续原来的上下文。

当 Codex 调用 `companion_send` 时，SDK 后端会用已绑定的 session id resume。TUI 后端则可以启动 `claude --resume` 或 `claude --continue`。

### compact 的原则

compact 不是越频繁越好。好的 compact 应该发生在：

- 当前任务已经汇报完成。
- 测试或验证结果明确。
- 没有正在运行的命令。
- 没有审批弹窗或未完成交互。
- 上下文压力已经中高，继续保留完整 transcript 的收益下降。

推荐流程：

1. 先调用 `companion_tui_compact_check`。
2. 看 `checkpointReady` 和 `recommendation`。
3. 只有推荐 `compact_now`，或用户明确要求时，才调用 `companion_tui_compact`。

`companion_tui_compact` 会发送带保护说明的 `/compact`，要求 Claude Code 保留：

- companion 分工关系。
- 当前项目状态。
- 最近关键决策。
- 未完成任务。
- 验证状态。
- blocker。
- 用户可见工作流假设。

## 状态栏与上下文压力监控

Claude Code 支持 statusLine。配置后，Claude Code 会把包含 `context_window` 的 JSON 发给命令。`cc-in-codex` 可以保存这些快照，用于更准确判断上下文压力。

在 Claude Code settings 中加入：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/cc-in-codex/dist/index.js statusline"
  }
}
```

配置后，快照会写到：

```text
~/.cc-in-codex/statusline/
```

`companion_tui_compact_check` 会优先使用 statusLine 的真实 `context_window.used_percentage`。如果没有配置，它会退回到屏幕长度和事件数量的启发式判断。

压力等级当前逻辑：

- `used_percentage >= 75`：high
- `used_percentage >= 60`：medium
- 其他：low

如果没有 statusLine：

- 事件很多、屏幕内容很长、字符数很高时提高压力等级。
- 这是保守估计，不是精确 token 读数。

## 安全与权限模型

默认策略是 `balanced`。需要注意：SDK 后端和 TUI 后端的安全边界不同。

SDK 后端通过 Claude Agent SDK 的工具许可回调做拦截，因此可以执行较强的工具级策略。TUI 后端运行的是原生 Claude Code CLI，`cc-in-codex` 负责可见启动、发送 prompt、发送 raw key、读取屏幕和打断，但不能在 MCP 层对 TUI 内部每一次工具调用做同等级别的路径拦截。

### mode

| mode | 含义 |
| --- | --- |
| `read-only` | SDK 后端阻止 mutating tools；TUI 后端把只读意图写入 companion prompt，但仍需依赖 Claude Code CLI 权限和人工监控 |
| `workspace-write` | 允许在项目目录内进行正常工程修改 |

### permissionPolicy

| policy | 含义 |
| --- | --- |
| `balanced` | SDK 默认策略，允许本地项目工作，并尽量阻止检测到的 cwd 外路径 |
| `strict` | SDK 只允许 `allowedTools` |
| `trusted` | 更信任 Claude Code 和本地环境 |

SDK 只读模式会阻止：

- `Bash`
- `Edit`
- `MultiEdit`
- `Write`
- `NotebookEdit`

SDK `balanced` 会检查常见路径参数，发现 cwd 外路径时拒绝。

TUI 后端的安全策略更接近“可见远程控制”：

- 用户可以 attach 到同一个 `tmux` pane 实时观看。
- Codex 可以用 `companion_tui_screen` 检查状态。
- 出现危险命令、错误循环、权限循环或用户要求停止时，Codex 可以发送 `C-c`。
- TUI 内部实际工具权限仍由 Claude Code CLI、项目设置、用户确认和本地环境共同决定。

注意：任何本地自动化工具都不能替代用户和 Codex 的审查。对于高风险命令、跨目录写入、删除操作、发布操作，Codex 应该保持明确审查。

## 本地状态与隐私

`cc-in-codex` 使用本地 Claude Code 登录态，不引入新的云端账户。

本地状态位置：

```text
~/.cc-in-codex/state.json
~/.cc-in-codex/statusline/
```

`state.json` 保存：

- cwd 到 companion 的绑定。
- Claude Code session id。
- tmux session 名称。
- attach command。
- 最近事件摘要。
- 最近结果。
- 配置项。

它不试图保存 Claude Code 的完整 transcript。完整 Claude Code session 由 Claude Code 自己维护。

## CLI 用法

`cc-in-codex` 默认作为 MCP server 从 stdio 启动。

### statusline

Claude Code statusLine 调用：

```bash
cc-in-codex statusline
```

通常不需要手动执行。

### attach

打开或 attach 项目的 TUI：

```bash
cc-in-codex attach /absolute/path/to/project
```

继续该项目最近的 Claude Code 对话：

```bash
cc-in-codex attach /absolute/path/to/project --continue
```

恢复指定 session：

```bash
cc-in-codex attach /absolute/path/to/project --resume <session-id>
```

关闭已有 cc-in-codex tmux pane 后再启动：

```bash
cc-in-codex attach /absolute/path/to/project --continue --replace
```

查看帮助：

```bash
cc-in-codex attach --help
```

## 开发与发布前检查

发布前必须跑：

```bash
npm run typecheck
npm run build
npm run smoke
npm pack --dry-run
```

推荐额外检查：

```bash
npm audit --audit-level=moderate
git status --short
```

`npm pack --dry-run` 应该只包含：

- `dist/`
- `scripts/smoke.mjs`
- `README.md`
- `README.en.md`
- `LICENSE`
- `package.json`

不要把 `node_modules/`、本地状态、日志、临时包、测试残留发布出去。

当前 `.gitignore` 已忽略：

```text
node_modules/
dist/
.DS_Store
.cc-in-codex/
*.log
```

## 常见问题

### 这个工具会不会影响我平时直接用 Claude Code

不会。它使用你本机已有的 `claude` 命令和 Claude Code 本地 session。你仍然可以正常打开 Claude Code CLI。

### 我能在 Claude Code CLI 里 resume 到 cc-in-codex 创建的对话吗

可以。`companion_status` 和 `companion_result` 会返回：

```bash
claude --resume <session-id>
```

你可以在终端里执行这条命令。

### Codex 能不能看到 Claude Code 的完整历史

不能天然看到。Codex 只能看到 MCP server 暴露的结果、摘要、屏幕捕获和项目文件。Claude Code 的完整上下文由 Claude Code 自己保留。

### TUI 是否实时同步

是。TUI 模式下，Claude Code 运行在 `tmux` 中。你 attach 到同一个 tmux session 后，会看到同一个原生 Claude Code 界面。Codex 发 prompt 时，输入会真实出现在这个界面里。

### 我能不能自己在 TUI 里打字

可以。你和 Codex 操作的是同一个 Claude Code TUI。需要注意的是，如果你手动改变了状态，Codex 可能需要通过 `companion_tui_screen` 或 `companion_status` 重新确认。

### 为什么 TUI send 不等待任务完成

因为 Claude Code TUI 是全屏交互界面，当前没有稳定结构化信号能证明“任务已完成”。`cc-in-codex` 选择保守：负责发送、监控、截图、打断，但不假装能完美解析 TUI 状态。

### SDK 和 TUI 是同一个进程吗

不是。SDK 后端和 TUI 后端是两条调用路径，但它们可以通过 Claude Code session id 连接到同一个会话上下文。TUI 可以用于观察/接管，SDK 适合结构化后台任务。

### 为什么需要 AGENTS.md 和 CLAUDE.md

因为项目长期指令应该进入仓库，而不是每次通过 prompt 重复注入。`AGENTS.md` 是 Codex 和 Claude Code 的共享项目记忆，`CLAUDE.md` 指向它。

### 没有 tmux 可以用吗

可以用 SDK 后端。只有 TUI 后端需要 `tmux`。

### statusLine 是必须的吗

不是。没有 statusLine 也能用。但配置 statusLine 后，compact check 能看到更准确的上下文窗口压力。

## 当前边界

这是一个本地优先的开发者工具，当前刻意保持简单。

已知边界：

- TUI 后端不保证自动判断任务完成。
- SDK 后端的 `--continue` 语义需要明确 session id；最近会话 continue 由 TUI 后端负责。
- statusLine 依赖 Claude Code 提供的 JSON 字段，字段变化时可能需要适配。
- `balanced` 路径检查覆盖常见工具参数，但不是形式化沙箱。
- 这个项目不替代 Codex 的最终 review。

## 推荐工作流

### 普通代码任务

1. 用户向 Codex 描述目标。
2. Codex 拆解任务。
3. Codex 调用 `companion_send`。
4. Claude Code 修改代码并运行检查。
5. Codex review diff 和验证结果。
6. Codex 向用户汇报。

### 复杂实现任务

1. Codex 先用 SDK 或本地工具读关键上下文。
2. Codex 打开 TUI：`companion_tui_open`。
3. 用户 attach 到右侧终端观看。
4. Codex 用 `companion_tui_send` 发送高质量任务。
5. Codex 定期用 `companion_tui_screen` 检查状态。
6. 出现错误循环或危险命令时，Codex 用 `C-c` 止损。
7. 任务完成后，Codex review 代码并跑最终检查。

### 长期项目

1. 初始化 `AGENTS.md` 和 `CLAUDE.md`。
2. 把稳定项目知识写入 `AGENTS.md`。
3. 让 Claude Code companion 持续在同一 cwd 工作。
4. 高压前在 checkpoint 做 compact。
5. 必要时通过 `claude --resume <session-id>` 手动接管。

## 开源协议

MIT。见 [LICENSE](./LICENSE)。
