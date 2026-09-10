# dsh-mcp-lazy ↔ pi-mcp-adapter 功能对齐报告

**对照对象**：`pi-mcp-adapter` v2.33.0（`32b67f9`，`~/Code_Project/pi-mcp-adapter`）
**方法**：四个只读切片审计（代理面/生命周期与传输/协议与认证/配置缓存与 UI）逐文件阅读并带 `file:line` 取证，加上本机实测（字符计数脚本、真实 MCP 进程端到端复现）。所有 pi 侧数字都来自源码常数，不是 README 转述。

> **修复状态**：§5 的 3 个缺陷与 §4.1 的评分差异**已全部修掉**；§5.4–§5.6 的 3 项行为差异**已补齐**；§6.3 的输出体量治理**已实现**。各节标题带 ✅ 标记，细节与验证证据见 §10「修复记录」。
>
> 仍未做的（认证、resources/prompts/elicitation/sampling、配置互操作、UI）是 v1 的有意边界，本次未变。
>
> **一个贯穿全部改动的不变量**：模型可见的工具面始终是 1525 字节 / 11 参数 / 381 token，与修复前**逐字节一致**（`node scripts/measure-surface.mjs` 可复现）。下面这些改动没有一项换来工具面的变化。

---

## 1. 结论

**核心机制基本一致；功能面差距很大。**

你最初要的那件事——一个恒定代理工具 + 服务器懒启动 + 磁盘元数据缓存——两边是同一个设计，关键常数我逐条核对后**完全一致**（见 §3）。这部分可以说对齐了。

但 pi 的源码是 28,109 行，本插件 3,066 行（约 1/9）。pi 在四个方向上整体超出，不是"少几个参数"的量级：

| 方向 | pi | 本插件 |
|---|---|---|
| 认证 | OAuth 2.1 全流程（授权码+PKCE / client_credentials / DCR / 发现 / issuer 绑定）+ OS 钥匙串 + 跨进程刷新锁 | 无（只有静态 headers） |
| 协议能力 | elicitation、sampling、resources、prompts、progress、list_changed 订阅、MCP Apps | 只有 tools |
| 输出体量治理 | outputGuard 截断+落盘、二进制资源落地、details 限幅、JSON Schema 方言校验 | 无任何截断 |
| 配置与界面 | 6 个配置源 + 7 种宿主导入 + TUI 面板 + CLI + 10 个斜杠命令 | DSH 原生 config 单源 |

另外实测出 **8 处行为差异，其中 3 处是本插件的真实缺陷**（§5：缓存过滤失效、驼峰搜索失效、正则无安全闸）。

但要说清楚一点：**在"省 token"这个它存在的理由上，本插件不落后，反而更省**（§8：恒定面约为 pi 的 45%）。差距在"能连什么、能干什么"，不在"省了多少"——不过 §6.3 的输出体量治理是个例外，那一项反过来会大幅吃掉节省。

---

## 2. 规模

| | pi-mcp-adapter | dsh-mcp-lazy |
|---|---|---|
| 版本 | 2.33.0 | 0.1.0 |
| 源码行数（不含测试） | **28,109** | **3,066**（约 1/9） |
| 测试行数 | 36,934 | 1,801 |
| 源文件数 | ~90 个 .ts 在仓库根 | 10 个 .ts |
| 运行时依赖 | 17 个（含 ajv、recheck、cross-spawn、undici、`@napi-rs/keyring`、`fs-native-extensions`、smol-toml） | 1 个（`@modelcontextprotocol/sdk`） |
| 持久化文件类别 | 13 | 1 |

---

## 3. 核心机制：逐条核对已对齐

这些是我声称"照 pi 原样"的部分，逐条取证过，**确实一致**：

| 机制 | pi | 本插件 | 结论 |
|---|---|---|---|
| 生命周期取值 | `keep-alive \| lazy \| lazy-keep-alive \| eager`，默认 `lazy`（`init.ts:294`） | 同四个值，默认 `lazy`（`index.ts:44`） | ✅ |
| 空闲回收默认 | 10 分钟，`0` 禁用（`lifecycle.ts:30`、`types.ts:589`） | 同（`schema.ts:27`） | ✅ |
| 模式→idle 覆盖 | `persistsAfterFirstSpawn = eager \|\| lazy-keep-alive` → `idleTimeout` 覆盖为 0（`init.ts:295-296`） | 同（`registry.ts` `resolveServer`） | ✅ |
| 回收判定 | `status==="connected" && inFlight===0 && now-lastUsedAt > timeoutMs`（`server-manager.ts:1731-1736`） | 同表达式（`connection.ts` `sweepIdle`） | ✅ |
| 扫描周期 | 30000 ms，`unref()`（`lifecycle.ts:93`） | 30000 ms，unref（`connection.ts:32`） | ✅ |
| 缓存文件 | `<agentDir>/mcp-cache.json`（`metadata-cache.ts:40-42`） | `$DSH_HOME/storages/mcp-lazy/cache.json` | 同构，路径随平台 |
| 缓存版本 | `CACHE_VERSION = 1`（`metadata-cache.ts:35`） | `CACHE_VERSION = 1` | ✅ |
| 缓存 TTL | 7 天（`metadata-cache.ts:36`） | 7 天（`schema.ts:30`） | ✅ |
| 缓存写入 | 临时文件 + `rename` 原子替换（`metadata-cache.ts:58-81`） | 同（`metadata-cache.ts:86-97`） | ✅ |
| 搜索权重 | `{name:12, originalName:10, server:8, description:5, keywords:5}`（`search-ranking.ts:13-19`） | `{qualifiedName:12, originalName:10, server:8, description:5, keywords:5}` | ✅ 数值相同 |
| 词干最短长度 | `MIN_STEM_LENGTH = 4` | 4 | ✅ |
| 搜索默认/分页 | limit 默认 12，offset 0 | 同 | ✅ |
| `searchKeywords` | 仅影响排序，不入 schema/描述/缓存 | 同 | ✅ |
| `directTools` | `boolean \| string[] \| "search"` | 同 | ✅ |
| `'search'` 语义 | 真 schema 但 inactive，`mcp({search})` 命中才激活 | 同 | ✅ |
| `freezeDirectTools` | 首次同步后冻结提升，保 prompt 前缀 | 同 | ✅ |
| 启动期零 I/O | 加载只读配置+缓存，不连接（`index.ts:254-257`） | 同（`apply()` 无 I/O，AC16 断言） | ✅ |

---

## 4. 对齐但实现更简（行为已产生差异）

这几项名义上有，实际行为不同：

### 4.1 ✅ 已修 — 搜索排序算法被简化了

权重数值一样，但**算法不是同一个**：

| | pi（`search-ranking.ts:107-188`） | 本插件（`search-ranking.ts:143-166`） |
|---|---|---|
| 整字段相等 | `weight * 14` + `wholeFieldExact` + `phraseMatched` | 无 |
| `startsWith` | `weight * 9` | 无 |
| `includes` | `weight * 6` | 无 |
| 逐 token 精确 | `weight * 4` | `weight * 1` |
| 词干前缀 | `weight * 2`（双向前缀） | `weight * 0.5`（双向前缀） |
| 覆盖率加成 | `+25`（100%）或 `+round(coverage*10)` | 无 |
| 首 token 命中 name | `+8` | 无 |
| 命中门槛 | `!phraseMatched && (tokens<=2 ? coverage!==1 : coverage<0.6)` → 拒绝 | **要求每个 token 都命中** |

### 4.2 模式分派优先级不同

- pi：`action > tool(call) > connect > describe > instructions > search > server(list) > status`（`direct-tools.ts:350`）
- 本插件：`search > describe > instructions > connect > tool > status`（`proxy-tool.ts:226-323`）

同时传 `search` 和 `tool` 时，pi 调用工具，本插件搜索。

### 4.3 代理工具的 description 是动态的

pi 的 `buildProxyDescription(config)` 会**列出服务器名**（`direct-tools.ts:314-318`），还列 search-mode 与 disabled 服务器。本插件是常量字面量（`proxy-tool.ts:43-46`），模型不调 `mcp({})` 就不知道有哪些服务器。

pi 的理由是"纯 config 函数，会话内稳定即可"；本插件的理由是"字节恒定，绝不触碰 KV 前缀"。两者都成立，但**这是可观察的行为差异**。

### 4.4 `search` 上限

- pi：`Math.max(1, limit)`，**无上限**（`search-ranking.ts:255-267`）
- 本插件：`min(max(1, limit), 40)`（`registry.ts:362`）

40 的上限是我的安全加料，但导致模型无法一次列全 100 个工具。

### 4.5 工具命名方案

- pi：`{prefix}_{tool}`，`prefix ∈ server|none|short|mcp`，默认 `server`（`types.ts:519, 805-813`），有 `BUILTIN_NAMES` 冲突跳过、跨服务器先到先得、≥75 条告警、`_meta.ui.visibility` 过滤
- 本插件：固定 `server__tool`（双下划线）

因为恒定带 `server__` 前缀，跨服务器和内置名冲突**不可能发生**，所以 pi 那套冲突机制在本插件里没有存在必要——这是简化而非缺失。缺的是 `toolPrefix` 的四模式可配、75 条告警、UI 可见性过滤。

### 4.6 环境变量

- pi：`inheritEnv` **默认 true**，整份拷贝 `process.env`，**无任何黑名单**（`server-manager.ts:1742-1761`）
- 本插件：默认**洗掉** `/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*`

安全上本插件更严，但这是个**迁移陷阱**：一个在 pi 下依赖环境里 `GITHUB_TOKEN` 的服务器，搬到本插件会静默起不来，除非显式写 `env`。

---

## 5. 实测发现的差异（3 处缺陷已修，4 项行为差异已补）

### 5.1 ✅ 已修 — 放宽 `includeTools`/`excludeTools` 永远不会生效

**端到端复现（真实 MCP 进程，7 个工具）**：

```
phase 1 live tools returned by server : 7
tools actually persisted in cache     : ["get_pixels","self_report","slow","add_tool","dump_env","always_fails"]
  -> cache stores the POST-filter set, and "echo" is absent
phase 2 (exclusion removed) search "echo" : 0 matches
configHash unchanged by the filter edit  : true
VERDICT: BUG CONFIRMED
```

两个机制叠在一起导致的：

1. 缓存写入的是**过滤后**的工具表（`registry.ts:312` `#recordLive` → `#filterTools` → `buildCacheEntry`），而读取时又过滤一次（`registry.ts:257`）。再过滤一次对已过滤集合是幂等的，**无法把被排除的工具找回来**。
2. `computeConfigHash` **排除**了 `includeTools`/`excludeTools`（`metadata-cache.ts:117-134`），所以改了过滤条件哈希不变、条目仍被判为有效。

后果：删掉一条 `excludeTools`、或扩大 `includeTools` 后，被排除的工具对 `search`/`describe`/`directTools` **持续不可见**，最长 7 天，直到偶然发生一次真实连接——而懒加载下这可能永远不发生。

收紧过滤是有效的（读取时再过滤会剔除）。所以症状是"只能变严不能变松"。

pi 两侧都做对了：`serializeTools` 只按 `t?.name` 过滤（`metadata-cache.ts:292-309`，即**存原始集合**），include/exclude 在**重建时**应用；并且这两个字段**算进哈希**（`metadata-cache.ts:87-110`）。所以 pi 不存在这个失效模式。

**修法（二选一，推荐前者）**：缓存改存未过滤的工具表、过滤只在读取路径做；或把 `includeTools`/`excludeTools` 加进 `computeConfigHash`。前者更好——过滤条件变化是廉价的，不该作废整份目录。

### 5.2 ✅ 已修 — 驼峰工具名无法子词搜索

`normalizeSearchText` 没有拆驼峰，而 pi 有（`([a-z0-9])([A-Z])` → `"$1 $2"`，`search-ranking.ts:77-82`）。

实测（工具名 `getPixels`，描述用中性文字以排除"描述里恰好含该词"的干扰）：本插件那列是真跑出来的；pi 那列是按它的 `normalizeSearchText` 源码推断（pi 仓库未装 `node_modules`，跑不起来）。

| 查询 | 本插件（实测） | pi（按源码推断） |
|---|---|---|
| `pixels` | **0 命中** | 命中（拆出 `get` / `pixels`） |
| `get pixels` | **0 命中** | 命中 |
| `getPixels` | 1 命中 | 命中 |

补一句为什么之前没发现：我第一次测的是带 "pixel data" 描述的工具，结果 `pixels` 命中了——命中的是**描述文字**里的 `pixel` 经词干匹配，把名字里的缺陷掩盖了。换成中性描述才暴露出来。

影响面不小：大量 MCP 服务器用驼峰工具名。此前测 `chrome-devtools-mcp` 也没暴露它，因为那个服务器是 snake_case。

### 5.3 ✅ 已修 — 正则搜索没有安全闸

pi 用 `recheck` 做 ReDoS 分析（`{attackTimeout:50, incubationTimeout:50, timeout:250}`），不安全就返回 `unsafe_pattern`，另有 256 字符查询上限（`proxy-modes.ts:29-35`）。本插件直接 `new RegExp(pattern,'i')`（`search-ranking.ts:207`）。

实测回溯爆炸（`(a+)+c` 对失败串）：

| 重复字符数 | 耗时 |
|---|---|
| 16 | 4 ms |
| 20 | 8 ms |
| 24 | 131 ms |
| 28 | **2078 ms** |

指数增长：36 个字符约 8 分钟。而且搜索是**同步**跑在工具调用里的，会阻塞事件循环——不只是慢，是整个会话卡住。

触发条件是需要 haystack 里有一段长同构字符（工具名+描述），不算随手可致，但一个描述里带长 ID/长串的服务器就能满足。pi 加了闸门，本插件没有。

### 5.4 ✅ 已补 — 没有失败退避

pi：适配器级 60 秒抑制（`failure-backoff.ts:3`），keep-alive 另有指数退避 30s→60→120→240→300s 封顶（`lifecycle.ts:14-15, 393-396`）。
本插件：完全没有。坏掉的服务器**每次调用都重新 spawn 并等满超时**。

### 5.5 ✅ 已补 — 没有 stderr 捕获

pi 保留子进程 stderr 最后 3 行 / 8 KiB 并附到连接错误里（`server-manager.ts:77-78, 866-871`）。本插件没有，启动失败只能看到 SDK 的报错，排查困难。

### 5.6 ◐ 部分处理 — 冷缓存不自愈，也不预热

pi 两条自愈路径：
- `mcp-cache.json` 不存在时 `bootstrapAll = true`，**首启连接所有启用的服务器**一次性填缓存（`init.ts:277-288`）
- 启用了 `directTools` 但缓存缺失/失效的服务器，启动时自动连接修复（`init.ts:436-480`，`metadata-cache.ts:166-192`）

本插件**从不自动连接**。这符合我原本的 AC2（"加载不 spawn 任何东西"），但代价是真实的：**新加一个服务器后，`mcp({search})` 只会说"还没有缓存"**，模型必须先想到调 `mcp({connect:"name"})`。pi 用户没有这一步。

### 5.7 — 工具集变更时的刷新语义更弱（未改，见说明）

pi 订阅 `tools/list_changed`、`prompts/list_changed`、`resources/list_changed` 三种通知并重建对应目录（`server-manager.ts:1097-1111`），MCP-2026 还走 `listen` 订阅加 `catalogStale` 标记。
本插件只处理 `ToolListChangedNotificationSchema`（工具列表）——对它支持的范围内是够的，但没有 prompts/resources 可言。

### 5.8 附带发现：正则命中排序

pi 的正则命中 `score: 0` 且**不重排**（保持元数据顺序）；本插件按名称重排。次要。

---

## 6. pi 有而本插件没有

按重要性排列。

### 6.1 认证（整块缺失）
- OAuth：授权码+PKCE（S256，`codeVerifier` 仅流程内存）、`client_credentials`、动态客户端注册（RFC 7591）、RFC 9728 PRM 发现、`authServerMetadataUrl` 覆盖、issuer 绑定（SEP-2352，变更即硬错）、RFC 9207 `iss` 校验、`state` 32 字节防 CSRF、手动/headless 回退（`mcp({action:"auth-start"|"auth-complete"})`）、回调服务器默认端口 19876 或 OS 分配
- Bearer：`bearerToken` / `bearerTokenEnv` / `bearerTokenStore`，内含 `${VAR}`/`$env:VAR`/`{env:VAR}` 插值与 `!command` 密钥间接引用
- 凭据存 **OS 钥匙串**（`@napi-rs/keyring`，service `pi-mcp-adapter.oauth` / `.bearer`），按服务器名哈希索引，Windows 分块 1000/1280 字节，**无明文回退**
- **跨进程刷新锁**（`fs-native-extensions` 内核咨询锁，目录 0700 文件 0600）
- 自定义 header、`requestHeadersCommand`（每请求跑命令）、`caFile`（PEM，仅 HTTPS）

### 6.2 协议能力
| 能力 | pi | 本插件 |
|---|---|---|
| `tools` | ✅ | ✅ |
| `resources` | ✅ 伪工具 `read_<name>`，`exposeResources` 可关 | ❌ |
| `prompts` | ✅ 注册成斜杠命令 `/mcp__<server>__<prompt>`，缓存内零连接注册 | ❌ |
| `elicitation` | ✅ 表单模式全流程（string/enum/bool/array/number 收集 + Ajv 校验 + 复核）+ URL 模式 | ❌ |
| `sampling` | ✅ 模型选择、两次交互确认、`samplingAutoApprove` | ❌ |
| `progress` | ✅ 代理调用路径经 `ui.notify` 桥接 | ❌ |
| `roots` | ❌（pi 也没有） | ❌ |
| `completions` | ❌（pi 也没有） | ❌ |
| `logging` | ❌（pi 也没有） | ❌ |

（`roots`/`completions`/`logging` pi 也没做，所以不算我的缺口。）

### 6.3 ✅ 已补 — 输出体量治理
pi 的 `mcp-output-guard.ts`：文本超 50 KiB / 2000 行即截断，全文落盘到临时文件并在结果里给出路径（"用 read/grep 去看"）；图片块原样透传；`details.mcpResult` 超 16 KiB 换成摘要；结构化内容保留 4 KiB/字段 512 字节；有降级阶梯。二进制资源（blob）落地为文件（单次 10 MiB、会话 100 MiB / 10000 文件上限），**base64 永不进上下文**。

**本插件没有任何截断。** 而且我原先在 `PLAN.md` 里写的"文本超限走现有 spill 策略"是**错的**。我核对了运行中的 harness（`~/.bun/install/global/node_modules/@deepseek-ai/`）：`spill` 的实际实现只出现在 `dsh-tool-bash`、`dsh-tool-fs-search`、`dsh-tool-pwsh`、`dsh-tool-cordis` 这些**单个工具各自的实现**里；`dsh-tools` 里唯一的 `spill` 是一句注释（`lib/types/ptc.js:383` 提到"a spill backend"），并不是对工具返回值的截断机制，`dsh-agent-loop` 也没有。**所以框架层不会替工具兜住超大输出——工具不自己截，就全额进上下文。**

这一条对"省 token"的目标伤害最大：插件省下的是工具定义那几百 token，而一次无上限的工具返回可以一口吃掉几万。

### 6.4 其它缺失
- `mcpScript`（沙箱 JS 批量调用，`tools.search/describe/call` + `emit`，30s 超时，16 MiB 中间量上限，按调用记 trace）——**但见 §7.2**
- `mcp({action:"install", url})` URL 安装
- `mcp({server:"x"})` 列出某服务器的工具（本插件该参数只用于消歧）
- 工具审批门（`approveTools` + 会话级批准 + `pi.appendEntry` 持久化 + broker 事件让权限扩展认领）
- MCP Apps：localhost UI 服务器 + SSE + 沙箱代理 + iframe 同意
- 协议时代协商 `protocolVersion: legacy|auto|2026-07-28`
- `npx` 父进程消除（见 §7.1）
- trace（仅元数据 JSONL，含脱敏）、status 事件通道、endpoint probe
- 配置互操作：6 个配置源 + 7 种宿主导入（cursor/claude-code/claude-desktop/codex/opencode/windsurf/vscode）+ agent plugin + claude plugin + Pi 包清单 —— **这是你 D2 明确不要的**，不算缺陷
- TUI 面板、`/mcp` 9 个子命令、`/mcp-auth`、CLI（token/init）
- SSE 与 unix socket 传输（本插件只有 stdio 与 streamable-http）
- JSON Schema 方言校验（Ajv 2020-12 / draft-07，其它方言直接报错）

---

## 7. 本插件有而 pi 没有，或本插件更好

### 7.1 恒定面更小
见 §8。

### 7.2 `mcpScript` 在 DSH 上有平台级等价物
pi 的 `mcpScript` 让模型用一个工具调用批量跑 MCP 调用。**DSH 原生有 `run_code`（PTC 模式）**：`dsh-tools` 导出 `RUN_CODE_NAME = 'run_code'`，文档字符串写着"Programs call the registry's agent-visible tools through nested executions … only the outer curated result enters model history"，且 `run_code` 是保留名、不可注册也不可被遮蔽。

也就是说，在 PTC 呈现模式下，模型本来就能写一段程序多次调用 `mcp({tool})`，只有外层结果进历史——**这就是 `mcpScript` 的能力**，不需要我在插件里再实现一个沙箱。

两点保留：(a) DSH 的呈现模式是 `native | ptc | both`（`dsh-tools` 的 `ToolRuntime.Config`，默认 `native`），是**整体二选一**而非像 pi 那样额外挂一个工具；(b) `mode:'ptc'` 下原生工具 schema 不进请求，本插件的代理工具也就不会出现在请求里，token 账完全变了。当前这个会话是 `native`。

### 7.3 默认洗环境变量
`scrubbedParentEnv()` 默认丢弃密钥样式的环境变量（§4.6）。更安全，但需要知道迁移代价。

### 7.4 服务器名校验在加载期
本插件在 `apply()` 就拒绝 stdio 缺 command、http 缺 url、`serverName` 重复（`index.ts:80-101`），错误出现在配置所在的时刻。pi 是**连接时**才检查"必须恰好配置 command/url/socket 之一"（`server-manager.ts:823-827`），而且 `serverName` 几乎不校验。

### 7.5 单依赖
运行时只依赖 `@modelcontextprotocol/sdk`，pi 有 17 个（含原生模块 `@napi-rs/keyring`、`fs-native-extensions`）。

---

## 8. token / 内存账

两边同一口径：字符数 ÷ 4（估算，非真实 BPE 分词；对 JSON 密集文本会低估，所以只用于两边对比，不用作绝对值）。

pi 的 `mcp` 描述是动态生成的（`buildProxyDescription`），所以我把函数从源码里抽出来真跑了一遍，而不是正则估长度：

| | pi | 本插件 |
|---|---|---|
| 模型可见工具数 | 2（`mcp` + `mcpScript`，后者默认开）+ 可选 direct tools | 1（`mcp`） |
| `mcp` 描述（渲染后） | **1409 字符**（0 服务器）／1448（3 个）／1519（10 个）≈ **352–380 token** | 297 字符 ≈ **74 token** |
| `mcp` 参数描述 | 14 个参数、16 处描述文字合计 825 字符 ≈ **206 token** | — |
| `mcpScript` 描述 | 804 字符 ≈ **201 token** | 不存在 |
| **整个工具定义** | `mcp` 一个约 **600 token**；加 `mcpScript` 约 **850 token**（未含 JSON 结构开销） | **1525 字节 ≈ 381 token**（脚本实测，含全部结构） |

**本插件的恒定面大约是 pi 的 45%**，而且省下来的不是靠砍功能描述——我的描述只占 74 token，其余是参数结构。

顺带一个事实修正：pi 的 README 写 "One proxy tool (~200 tokens)"，但它 `mcp` 工具的**描述文字本身**渲染出来就有 1409 字符 ≈ 352 token。README 那个数字早过时了（描述后来长出了 install / auth / ui-messages 三块用法说明）。

反向的账：pi 有 outputGuard（防一次工具返回吃几万 token）、npx 父进程消除（每个 npx 服务器少一个进程）、缓存 payload 精简（丢 `_meta`、mimeType）、`directTools:"search"` 让工具保持 inactive。**本插件这四项都没有。** 所以"谁更省"取决于用法：工具多、调用少的场景本插件赢；有服务器会吐大结果的场景 pi 赢很多。

---

## 9. 建议

按性价比：

1. **修 §5.1 缓存过滤 bug**（必做）。改法：缓存存原始工具表，过滤只在读取路径做；顺带把 `includeTools`/`excludeTools` 加进哈希做双保险。要加回归测试。
2. **修 §5.2 驼峰分词**（必做，一行的事）。`normalizeSearchText` 加驼峰拆分，并把 §4.1 的覆盖率门槛与加成项补齐。补测试用驼峰工具名。
3. **修 §5.3 正则安全闸**（该做）。至少加查询长度上限；`recheck` 不宜引入（多一个依赖），可以退而用"长度上限 + 执行时间预算"。
4. **补输出截断**（该做，且是省 token 目标的核心缺口）。至少给工具结果加字节/行上限 + 落盘路径提示。
5. **补失败退避 + stderr 尾巴**（该做，都是小改动，直接影响可诊断性）。
6. **冷缓存自愈**：加一个 opt-in 的"首启预热"配置（默认关，保持 AC2），或者让 `mcp({})` 的状态输出明确提示"这些服务器还没有缓存，调 connect 拉取"（后者更便宜，且不破坏懒加载语义）。
7. 认证、resources/prompts/elicitation/sampling、配置互操作、UI：**v1 明确不做**，边界已写在 README「已知不做」与 `PLAN.md` D6。这次审计没有改变这个结论，只是把缺口的体量量化了。

---

*本报告的所有 pi 侧结论都可在 `~/Code_Project/pi-mcp-adapter` 对应 `file:line` 复核；本插件侧缺陷均已在真实 MCP 进程上复现。*

---

## 10. 修复记录

本节记录 §9 建议的落地结果。每条都带回归测试，且**没有一个改动触碰模型可见的工具面**。

### 10.1 缓存过滤失效（§5.1）

**改法**：把过滤从写入路径整体移到读取路径。
- `registry.ts` 拆出 `#nameTools`（只重算限定名）与 `#filterTools`（重算 + 过滤）。
- `#recordLive` 现在把 **未过滤**的目录写进缓存，`#known` 仍然只放过滤后的结果。
- `metadata-cache.ts` 的 `computeConfigHash` 继续忽略 `includeTools`/`excludeTools`——但注释里写明了这**只**在"缓存存全量"的前提下成立，两者必须同时为真。这正是原来出错的地方：字段被排除出哈希，却被烘焙进磁盘数据。

**为什么不去改哈希**：改哈希也能修掉症状，但代价是每次调整过滤条件就让整份目录作废、下次还得重连。过滤是廉价的读取期操作，不该有这种权力。

**验证**：`connection.e2e.test.ts` 新增 3 个真实进程用例。其中 2 个在旧代码上**确认变红**（我临时回退了修复跑过一遍），第 3 个（收紧过滤）两边都过——它记录的是这个 bug 的不对称性，不是回归。

### 10.2 搜索：驼峰分词与评分对齐（§4.1、§5.2）

**改法**：`normalizeSearchText` 在转小写**之前**拆分驼峰（顺序不能反，`aB` 的边界会被小写破坏）。评分按 pi 的结构重写：整字段命中 `×14` / 前缀 `×9` / 子串 `×6`，逐 token 精确 `×4` / 词干 `×2` / 裸子串 `×1`，再叠加覆盖率加成、首 token 落在名称上的 `+8`、整字段精确的 `+20`；命中门槛改为"词组命中恒通过，≤2 token 要求全覆盖，>2 token 要求覆盖 ≥60%"。

保留了一处刻意的宽化：分词仍是 Unicode 感知的（`\p{L}\p{N}`），而 pi 只认 ASCII。所以非拉丁文字的工具名在本插件里可搜，在 pi 里会被丢掉。

**验证**：新增 `test/unit/search-ranking.test.ts`（32 个用例）。关键用例用**中性描述**——第一版测试用了含 "pixel data" 的描述，`pixels` 靠描述里的词干匹配蒙对了，把名字里的缺陷盖住；换成中性描述才复现。

### 10.3 正则安全闸（§5.3）

**改法**：三层拒绝，都作为值返回而不是抛出——超过 256 字符、结构上嵌套了无界量词、语法非法。

嵌套量词检测是一次保守的结构扫描（跟踪分组深度与"该分组内是否含无界量词"），命中 `(a+)+` / `(a*)*` / `(a{2,})+` / `((ab)+)+` 这类形状。

**这里有个必须说清的取舍**：pi 用的是 `recheck` 分析器，那是一个额外依赖；本插件保持了单依赖，因此换来的只是**更窄的保证**——重叠选择分支 `(a|aa)+` 和多项式级 `a*a*a*b` 不在此检查范围内。这一点写进了代码注释，不是暗示，是明说。

**顺带修掉一个 UX 缺陷**：正则被拒时，`SearchOutcome` 原先不带错误字段，模型看到的是"No MCP tool matches"——它会据此认定工具不存在，而不是自己的模式写错了。现在 `SearchOutcome.error` 贯穿到 `renderSearch`，原样展示拒绝原因。旧测试 `reports a regex syntax error` 断言的恰恰是那个误导行为，已改名并改写。

**验证**：守卫针对 40 字符重复串的 `(a+)+c` 在 **0.0 ms** 内拒绝（修复前同一形状要 2 秒以上）；测试断言耗时 < 100 ms，即守卫必须在引擎看到模式之前生效。

### 10.4 输出体量治理（§6.3）

**改法**：新增 `src/output-guard.ts`。超过 50 KiB 或 2000 行即保留**头部**、把全文写入 `tmpdir()` 下的 0600 文件，并在结果里附上路径与读取建议。行切先于字节切（反过来会留下半行，让行数统计说谎），字节切不劈开 UTF-8 序列，落盘本身有 16 MiB 上限（防跑飞的服务器填满磁盘）。

只对**服务器写的**载荷生效：工具返回、`describe` 的 schema、服务器的 instructions。网关自己生成的状态/搜索/错误文本按构造就是有界的，过一遍守卫只会凭空造出一个没人需要的落盘文件——有测试用 1 字节的上限证明这一点。

配置面是 `outputGuard: true | false | { maxBytes, maxLines }`，默认开。有测试断言**无论怎么配都不改变工具定义**。

**为什么这条最重要**：插件省下的是工具定义那几百 token，而一次无上限返回能吃掉几万。修复前的 `PLAN.md` 里写着"文本超限走现有 spill 策略"——那是错的，见 §6.3。

### 10.5 失败退避与 stderr 尾巴（§5.4、§5.5）

**改法**：
- `FAILURE_BACKOFF_MS = 60_000`。失败后 60 秒内不再自动重试，错误信息里带上"多久前失败、还剩多久、原因"。**显式 `mcp({ connect })` 强制绕过退避**——刚修好命令的人不该被迫等窗口过去。成功即清除退避与错误记录。
- stdio 子进程的 stderr 改为 `pipe` 并保留有界尾巴（8 K 字符 / 最后 3 行），失败时折进错误信息。SDK 默认是 `inherit`，那种情况下 `transport.stderr` 是 `null`，**根本拿不到诊断**——这是第一次测试失败时发现的。
- 新增 `ServerEntry.debug`：设 true 就恢复 `inherit`，把子进程日志还给终端。捕获是默认，因为启动失败才是常见场景，而尾巴是唯一能解释它的东西。
- `ServerStatus.failedAgoSeconds` 与状态文本里的 `retry suppressed, failed Ns ago` 让抑制状态对模型可见。

**验证**：用 fixture 的 `FIXTURE_FAIL` 开关（它在退出前会写 stderr 并递增启动计数），所以"抑制期间没有第二次 spawn"是**数出来的进程事实**，不是读代码推断的。

### 10.6 冷缓存指引（§5.6）

**改法**：`mcp({})` 的状态输出现在会把"无缓存且从未连接"的服务器挑出来，逐个点名并给出 `mcp({ connect: "名字" })`，同时说明连接过一次之后搜索就不需要再启动任何东西。

**没有做自动预热**。pi 在缓存文件缺失时会首启连接所有启用的服务器；那与 AC2（"加载不 spawn 任何东西"）直接冲突，而 AC2 是本插件省内存的根基。这里选择把"模型缺一个动作"变成"状态里明写那个动作"，代价是零进程、零 I/O。禁用服务器不会被点名（有测试）。

### 10.7 未改的项

- **§5.7 刷新语义**：只订阅 tools 的 `list_changed`。因为本插件不支持 prompts/resources，pi 的那两种通知在这里没有对应物；等做那两项时一起补才合理。
- **§5.8 正则命中排序**：pi 保留元数据顺序、我按名称排序。我的顺序是确定性的，且不依赖 Map 迭代次序，保留。
- **认证 / resources / prompts / elicitation / sampling / 配置互操作 / UI**：v1 的有意边界，本次未动，仍写在 README「已知不做」与 `PLAN.md` D6。

### 10.8 验证汇总

| 项 | 结果 |
|---|---|
| `npm test` | 174 通过 / 0 失败（本轮从 110 增至 174） |
| `npm run check` | 通过（typecheck + build 无输出） |
| `npm run test:types` | 通过 |
| 恒定工具面 | 1525 字节 / 11 参数 / 381 token，**与修复前逐字节一致** |
| 真实服务器省 token | `chrome-devtools-mcp@1.6.0`（29 工具）5313 → 381 token，**92.8%**，与修复前一致 |
| 原缺陷复现脚本 | 由 `BUG CONFIRMED` 转为 `no bug`，且 `fromCache: true`（未额外启动进程） |
| 残留进程 / 残留 spill 目录 | 均为 0 |
