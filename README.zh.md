# dsh-mcp-lazy

一个给 DeepSeek Harness 用的**懒加载 MCP 网关**：模型面前只有一个恒定的小工具，服务器用到才启动、闲下来就回收，工具元数据落盘缓存 —— 所以「按需发现」不花连接成本。

实测（`chrome-devtools-mcp@1.6.0`，29 个工具）：

| | 每次请求的固定成本 |
|---|---|
| 原生注册（`dsh-mcp-client` 的做法） | 21252 字节 ≈ **5313 token** |
| 本插件 | 1525 字节 ≈ **381 token** |
| 省下 | **92.8%** |

而且这个 381 是**恒定值**：再挂 10 台服务器它也不变，因为那些 schema 变成了"要用时才读"。

---

## 装

在 profile 里加一行（`~/.dsh/profiles/<名字>/cordis.patch.yml`）：

```yaml
- insert:
    - id: mcp-lazy
      name: 'dsh-mcp-lazy'
```

## 配置

```yaml
- id: mcp-lazy
  name: 'dsh-mcp-lazy'
  config:
    idleTimeout: 10          # 分钟；0 = 永不回收
    freezeDirectTools: false # 见下面「原生提升」
    outputGuard: true        # 服务器返回值体量上限，见下面「输出上限」
    servers:
      - serverName: chrome
        transport: stdio
        command: npx
        args: ['-y', 'chrome-devtools-mcp@1.6.0']

      - serverName: docs
        transport: streamable-http
        url: http://127.0.0.1:3000/mcp
        headers:
          Authorization: 'Bearer ...'
```

### 插件级字段

| 字段 | 默认 | 含义 |
|---|---|---|
| `idleTimeout` | `10` | 空闲多少分钟回收连接；`0` = 不回收 |
| `freezeDirectTools` | `false` | 首次同步后冻结原生提升，锁住请求前缀 |
| `outputGuard` | `true` | 服务器返回值体量上限；`false` 关闭，或 `{ maxBytes, maxLines }` 调参 |
| `servers` | `[]` | 服务器列表 |

### 每个服务器的字段

| 字段 | 默认 | 含义 |
|---|---|---|
| `serverName` | 必填 | 命名空间，`[A-Za-z0-9_-]{1,32}`，全局唯一 |
| `transport` | 必填 | `stdio` 或 `streamable-http` |
| `command` / `args` / `env` / `cwd` | — | stdio：可执行文件、参数、额外环境变量、工作目录 |
| `url` / `headers` | — | HTTP：端点与额外请求头 |
| `toolCallTimeoutMs` | `60000` | 单次 `tools/call` 超时 |
| `lifecycle` | `lazy` | `lazy` / `lazy-keep-alive` / `eager` / `keep-alive` |
| `idleTimeout` | 继承全局 | 该服务器的回收窗口（分钟），`0` = 不回收 |
| `directTools` | 不提升 | `true` / `string[]` / `'search'`，见下 |
| `includeTools` / `excludeTools` | — | 名字或 glob，按原始名 / 限定名 / 去前缀名匹配 |
| `searchKeywords` | — | `{ "工具名或glob": ["关键词"] }`，只影响搜索排名，不进 schema |
| `debug` | `false` | stdio 子进程的 stderr 直通终端；默认被捕获用于失败诊断 |
| `disabled` | `false` | 保留配置但不连接、不调用 |

### 输出上限

服务器返回的文本超过 **50 KiB 或 2000 行**就只保留开头，全文写到临时文件，并把路径告诉模型：

```
[MCP output truncated: original 41233 lines / 3.1 MiB. showing the first 2000 lines.
 Full text saved to: /tmp/dsh-mcp-lazy-output-xxxx/output-ab12cd34.txt — read it with offset/limit, or grep it.]
```

为什么默认开：本插件省下的是工具定义那几百 token，而一次不设限的返回能一口气吃掉几万。DSH **没有**框架级的工具输出截断（`spill` 只是 bash / fs-search / pwsh 等单个工具自己的实现），所以工具不自己截就全额进上下文。

只对**服务器写的**内容生效（工具返回、schema、服务器 instructions）；网关自己的状态/搜索文本本来就有界。落盘文件是 0600，单文件上限 16 MiB，插件卸载时清理。改上限：

```yaml
outputGuard:
  enabled: true
  maxBytes: 262144   # 256 KiB
  maxLines: 8000
```

`outputGuard: false` 完全关闭（不建议：有服务器会吐大结果时，这是最花钱的一项）。

### 失败退避与诊断

服务器启动失败后 **60 秒内不再自动重试**——否则每次提到它某个工具的调用都会重新 spawn 并等满超时。状态里会写明：

```
  broken — 0 tools (lazy, failed, retry suppressed, failed 12s ago)
      last error: ... (stderr: fixture: configured to fail before serving)
```

括号里的 `stderr:` 部分是子进程最后的输出（最多 3 行），启动失败通常只有它能说明原因。设 `debug: true` 可以把 stderr 还给终端自己看，代价是错误信息里不再带这段。

显式 `mcp({ connect: "名字" })` **不受退避限制**——刚修好命令的人不用等窗口过去。

### 冷缓存

新加的服务器在第一次连接之前没有工具元数据，搜索自然找不到它。这时 `mcp({})` 会点名并给出动作：

```
2 MCP servers configured.
  a — 0 tools (lazy, no metadata yet)
  b — 0 tools (lazy, no metadata yet)

Search cannot find tools on a, b yet, because nothing is cached and no server has
been started. Call mcp({ connect: "a" }) or mcp({ connect: "b" }) once; after that
their tools are searchable without starting anything.
```

本插件**不会**在启动时自动连接去预热缓存——加载期零进程是它省内存的根基。代价就是这一次显式的 `connect`。

### 生命周期怎么算

- `lazy`（默认）：首次调用才启动，闲置超过窗口就回收。
- `lazy-keep-alive`：首次调用才启动，之后**永不回收**。
- `eager`：插件加载时就启动，但闲置仍会回收。
- `keep-alive`：加载就启动，且永不回收。

后两者（会常驻）的 `idleTimeout` 自动为 `0`，除非你显式写了别的值。

回收的判据是「连接活着 **且** 没有在途调用 **且** 空闲超过窗口」。**在途调用永远不会被回收掉**，长任务安全。

## 从 `@deepseek-ai/dsh-mcp-client` 迁移

把每行的 `config` 塞进 `servers` 数组，去掉各自的 `id`：

```yaml
# 之前
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']

# 之后
- id: mcp-lazy
  name: 'dsh-mcp-lazy'
  config:
    servers:
      - serverName: github
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
```

传输层字段含义完全一致。两者可以同时挂（`serverName` 不同即可）。

## 模型看到的工具

只有一个：

```
mcp({ search: "screenshot" })                    # 找工具，走缓存，不启动任何东西
mcp({ describe: "take_screenshot" })             # 看完整参数 schema
mcp({ tool: "show_pixels" })                     # 调用（此时才启动服务器）
mcp({ tool: "echo", server: "docs" })            # 两台服务器有同名工具时消歧
mcp({ connect: "chrome" })                       # 只连上并刷新缓存，不调用
mcp({ instructions: "chrome" })                  # 看服务器自己的说明
mcp({})                                          # 状态：每台服务器的工具数 / 连接态 / 缓存年龄
```

支持名字的多种写法：`take_screenshot`、`chrome__take_screenshot`、`chrome:take_screenshot` 都认。

**冷启动也能用**：一个工具名在缓存里没有时，网关会按配置顺序去连那些还没连过的服务器找它（连到第一个命中的就停）。连不上的服务器会被跳过并记下原因，不会让其他服务器跟着不可用。

## `directTools`：可选的「原生提升」

默认全部走代理，工具面前缀永远不动。如果你有几个工具调用极其频繁，多一跳是纯开销，可以让它们变成真原生工具：

- `directTools: true` —— 该服务器所有工具都原生注册。
- `directTools: string[]` —— 只注册列出的（支持 glob）。
- `directTools: 'search'` —— **先注册但不激活**，等 `mcp({ search })` 真的搜到它才激活。这样不搜索的会话完全不付这次前缀变化的代价。

### ⚠️ 前缀会变

这是本插件唯一会移动模型可见面的开关。工具集一变，请求前缀就变，KV cache 从第一个变化的 token 起失效。所以：

- 默认不开；
- `'search'` 模式把代价推迟到「模型真的去找」的那一刻；
- `freezeDirectTools: true` 让首次同步后不再接受新的提升，把前缀抖动限制成一次事件。

## 验收状态

`174` 个自动化用例，覆盖计划里的 AC1–AC18：

```bash
npm run check                      # typecheck（含测试类型）+ build
npm test                           # 全部用例，约 16 秒
node scripts/measure-surface.mjs   # 恒定成本：381 token
node scripts/measure-token-savings.mjs 3
node scripts/measure-token-savings.mjs --npx chrome-devtools-mcp@1.6.0 --isolated
```

几个值得单独说的验证方式：

- **「不启动任何东西」不是靠读代码断言的**：测试把所有可能被 spawn 的可执行文件换成必定失败的脚本并改写 `PATH`，真启动了就会炸。
- **进程事实**：端到端测试会真的拉起一个 MCP 服务器 fixture，通过计数器文件证明「首次调用才 spawn」「复用同一个进程」「回收后会重新 spawn」「退避期间没有第二次 spawn」。
- **缓存命中证明**：搜索用例跑在没有任何服务器进程的前提下。
- **回归用例有效性**：修缓存过滤缺陷时，我临时把修复回退跑了一遍，确认新用例在旧代码上确实变红——否则它只是装饰。

### 与 `pi-mcp-adapter` 的功能对照

见 `PARITY.md`：逐模块审计过一遍（pi 28,109 行源码 vs 本插件 3,066 行），列出已对齐项、行为差异、以及实测出的缺陷。本轮据此修掉了 3 个缺陷并补齐 3 项能力，**没有一项改动移动模型可见的工具面**（仍是 1525 字节 / 11 参数 / 381 token）。

代价要一并说清：pi 的恒定面约 850 token（它有两个工具 + 更长的描述），本插件约 381；但 pi 有完整的 OAuth、resources/prompts/elicitation/sampling、配置互操作与 UI，本插件没有。**省 token 这件事上本插件更省，能连什么、能干什么上差得远。**

## 已知不做（v1 边界）

- **OAuth / bearer 存储**：只用明文 `headers` 或环境变量。
- **图片结果不转发像素**：MCP 的 image / audio 块会被投影成一行元数据（类型 + 字节数）。要真正进会话需要接 attachment 存储。
- **不做 MCP resources / prompts**：只桥接 tools。因此 pi 的 `resources/list_changed` 与 `prompts/list_changed` 订阅在这里没有对应物（只订阅 `tools/list_changed`）。
- **不做 sampling / elicitation**。
- **不做共享进程**（rmcp-mux 那类），也不把 `npx` 解析成真实二进制以消掉 npm 父进程（pi 会，能省一个进程）。
- **不做 `.mcp.json` 兼容层**：只读 DSH 原生 config。
- **不做审批门**：MCP 调用走 DSH 自己的权限预设。
- **不做配置互操作**：pi 能读 6 个配置源并导入 7 种宿主格式（Cursor / Claude Code / Codex / opencode / Windsurf / VS Code），本插件只用 DSH 原生 config。
- **正则安全闸比 pi 弱**：pi 用 `recheck` 分析器，本插件为了保持单依赖只做「长度上限 + 嵌套无界量词检测」。重叠选择分支（`(a|aa)+`）和多项式级回溯（`a*a*a*b`）不在此范围内。

## 开发

```bash
npm install
npm run build      # src/ -> lib/
npm test           # 自动先 build
npm run link-dsh   # 把 peer 包链到「正在运行的」DSH 安装
```

`link-dsh` 不是可选项。`@deepseek-ai/dsh-*` 是 peer 依赖，运行时由 harness 从自己的安装提供；如果 npm 在本包 `node_modules` 下也放了一份私有副本（比如 registry 上的 `rc.2` 对上你正在跑的 `rc.1`），插件就会用**另一个实例**的 `defineTool` 去构造定义，交给运行时注册 —— 报错莫名其妙，或者悄悄差一个版本。

## 许可

MIT。连接层与环境洗白规则改自 `@deepseek-ai/dsh-mcp-client`（MIT, Copyright (c) 2026 DeepSeek）；单代理网关、元数据缓存、生命周期与搜索排名改自 `pi-mcp-adapter`（MIT, Copyright (c) Nico Bailon）。详见 `LICENSE`。
