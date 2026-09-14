# dsh-mcp-lazy — 实现计划与验收标准

> 目标：给 DSH 做一个「pi-mcp-adapter 式」的 MCP 插件：**一个恒定代理工具 + 服务器懒启动 + 元数据缓存**，
> 基于 `@deepseek-ai/dsh-mcp-client` 魔改，token 与内存成本都从「启动即全量」变成「用到才付」。
>
> 状态：**已完成**（v0.1.0）。本文件是开发期写下的计划与验收标准，保留作设计记录；
> 与代码不一致时以代码为准。参照物：`pi-mcp-adapter` @ `32b67f9` (v2.33.0)。

---

## 1. 问题陈述（已验证的事实）

DSH 官方 `@deepseek-ai/dsh-mcp-client` (0.1.5-rc.1) 的实测行为：

| 维度 | 现状 | 来源 |
|---|---|---|
| 发现时机 | `apply` 阶段就 await 首次连接 + 全量 `tools/list` | package README「Lifecycle and sync」 |
| 工具面 | 每个 MCP 工具注册为原生工具 `mcp__<server>__<tool>` | `tools.ts` `publicToolName()` |
| token | 「tool descriptions and input schemas enter every request **while the tools are registered**」 | README「Token effect」 |
| 内存 | 1 条目 = 1 常驻连接；stdio = 1 常驻子进程 | `transport.ts` + supervisor |
| 释放条件 | 仅 HMR/重载，或重连预算耗尽（默认连续 10 次失败） | README「Startup, updates, and reconnection」 |
| 懒加载 | **不存在**：无 lazy/defer/on-demand 概念，`ToolDefinition` 无可见性开关 | bundle grep + `dsh-tools/lib/types/index.d.ts` |

pi-mcp-adapter 的对照做法：

- **恒定单代理工具** `mcp`（`index.ts:1380` `registerProxyTool`）：`search` / `describe` / `instructions` / `connect` / `tool`+`args` / `action`(install, auth) / `server` 消歧 / `limit`+`offset` 分页。
- **元数据磁盘缓存**（`metadata-cache.ts`）：`mcp-cache.json`，`CACHE_VERSION=1`、`CACHE_MAX_AGE_MS=7d`、按 `computeServerHash(definition)` 判有效；`search`/`describe` 因此**不需要活连接**。
- **生命周期**（`types.ts:460`）：`lazy`（默认）/ `eager` / `keep-alive` / `lazy-keep-alive` + 每服务器 `idleTimeout`（分钟）+ 全局兜底。
- **空闲回收**（`server-manager.ts:1731 isIdle`）：`status==='connected' && inFlight===0 && now-lastUsedAt > timeout`；`lifecycle.ts` 30s 健康检查 interval + 指数退避重连（`KEEP_ALIVE_RETRY_BASE_MS`，上限封顶）。
- **可选提升**：`directTools?: boolean | string[] | "search"` 把个别工具注册成原生工具（`direct-tools.ts`），`"search"` 表示先注册但不激活，被搜到才激活。

关键洞察：pi 省 token 的本质不是「动态增删工具」，而是**模型看到的工具面恒定为一个代理工具**。
动态增删会让工具定义前缀变化，从第一个变化的 token 起击穿 KV cache（DSH README 明确写了这一点）。
所以本插件的 v1 必须保持**恒定单工具**。

---

## 2. DSH 侧可行性（已验证）

| 需要的能力 | DSH 是否提供 | 证据 |
|---|---|---|
| 运行时注册/注销工具 | ✅ | `ToolRuntime.register(def): () => void`（disposer）、`restrict(filter): () => void` |
| 观察工具面变化 | ✅ | `tools/change` 事件（"A tool was registered or unregistered"） |
| 单插件对多服务器 | ✅（配置即组合） | 每个 `ctx.tools.register` 独立作用域；一个插件条目一组 config |
| 自带 MCP 连接 | ✅ | `@modelcontextprotocol/sdk` 1.30.0 已在本机依赖树 |
| 沿用现成连接监督 | ✅ | `dsh-mcp-client` 的 `connection.ts` / `transport.ts` 可直接改自 |
| 每-agent 收窄 | ✅ | `ctx.tools.restrict` / `presentAs`（agent preset 层） |
| 图片结果投影 | ✅ | `dsh-mcp-client` 已实现 attachment 投影，可复用 |

结论：**架构不需要等上游**，缺的只是代理层 + 缓存 + 生命周期。

---

## 3. 设计决策（待确认项标 ❓）

### D1 — 模型可见工具面 ✅（照 pi 原样）
- **默认**：恒定注册 1 个工具 `mcp`，schema 一次定型、永不变化 → KV cache 稳定。
  pi 侧 `settings.directTools` 缺省即「不提升」，全部经代理走（`direct-tools.ts:189-210`）。
- **可选**：`directTools: true | string[] | "search"`（全局 `settings.directTools` + 每服务器覆盖）。
  - `true` / `string[]`：把工具注册成**真原生工具**（真 schema），代价是工具面前缀会变。
  - `"search"`（pi 的巧思，必须照搬）：工具以**真 schema 但 inactive** 状态注册，模型只能通过
    `mcp({ search })` 触达；**搜索命中即激活**，之后可直接按名调用
    （`direct-tools.ts:200-204`；代理工具描述里会追加 "Search-mode servers (...)" 段落告知模型）。
- **缓存保护开关**：`freezeDirectTools`（pi 同名设置）——初始同步后冻结 direct 注册，
  后续元数据更新/重连**不再重建系统提示**，稳住 prompt-cache 前缀；代理/搜索/缓存元数据照常刷新。
- 结论：默认路径（纯代理）恒定；只有显式配置 directTools 才承担前缀风险，且提供 freeze 兜底。

### D2 — 配置来源 ✅
- **只用 DSH 原生 config**：一个插件条目 = 一台服务器，与 `dsh-mcp-client` 字段命名一致
  （`serverName` / `transport` / `command` / `args` / `env` / `cwd` / `url` / `headers` / `toolCallTimeoutMs`），
  现有配置可直接搬过来。**不**引入 `.mcp.json` 兼容层（留作 v2）。

### D3 — 生命周期与回收 ✅
- `lifecycle`：`lazy`（默认）/ `eager` / `keep-alive` / `lazy-keep-alive`。
- `idleTimeout`：**默认 10 分钟，`0` 表示禁用回收**。
- 落地规则（`src/registry.ts` 的 `resolveServer`）：**只有 `lazy` 回收**，其余三种一律解析为 `0`；
  显式 `idleTimeout` 永远优先。`eager` / `keep-alive` 另外在插件激活时连接（`src/index.ts` 消费
  `registry.residentServers()`），而该列表对默认的全 `lazy` 配置为空——所以「加载期零进程」这条
  根基没有被破坏。

  > 原计划照抄 pi 的 `persistsAfterFirstSpawn = (eager || lazy-keep-alive)`。那样写有两个问题，
  > 都在 v0.1.0 发布前修掉了：`keep-alive` 会被按全局窗口回收（pi 靠一个独立的 keep-alive 集合
  > 让扫描跳过它，本插件没有那个集合），而 `eager` / `keep-alive` 根本没在激活时连接——文档承诺
  > 了，代码没做。详见 `../CHANGELOG.md` 的 Fixed 一节。
- 回收判据：连接活着 **且** 无在途调用 **且** 空闲超过窗口；30s 扫一次，`unref` 不阻止宿主退出。
- 重连：复用 `dsh-mcp-client` 的退避（500ms 起翻倍、30s 封顶、10 次预算），但**启动时不消耗预算**。

### D4 — 缓存形状 ✅
**磁盘 JSON 缓存**：
```
~/.dsh/storages/mcp-lazy/cache.json
{ "version": 1, "servers": { "<name>": {
    "configHash": "<sha256>", "cachedAt": 0, "ttlMs": null,
    "tools": [{ "originalName","description","inputSchema","outputSchema" }],
    "resources": [], "instructions": "…" } } }
```
- 失效：`configHash` 变化 / 超龄（默认 7d，pi 为 `CACHE_MAX_AGE_MS`）/ 服务器 `tools/list_changed` 后重同步。

### D5 — 调用路径与错误面（照 pi 的动作集，按 DSH 习惯落地）
- 代理工具动作：`mcp({ search })` / `mcp({ describe })` / `mcp({ tool, args, server? })` /
  `mcp({ connect })` / `mcp({ instructions })` / `mcp({})`(状态)；`regex` / `includeSchemas` / `limit` / `offset` 修饰。
- 未知名 → 候选建议（照 pi 的 `rankSuggestions`）；歧义名 → 要求 `server`；失败 → 明确诊断，绝不伪造成功。
- 超时：`toolCallTimeoutMs` 默认 60s，透传 `exec.signal`。
- 输出体量：`search` 默认 `limit=12`、硬上限 40；文本超限走现有 spill 策略。

### D6 — v1 明确不做
OAuth / bearer 存储、UI apps（MCP-UI）、resources-as-tools、prompts、sampling / elicitation、
rmcp-mux 共享进程、per-request header 命令、Claude/Agent Plugins 加载器、`inheritEnv` 细分开关、
pi 的脚本模式（`scriptMode`）、审批门（`approveTools`）。
→ 这些留成 README「Known Limitations」，避免 fork 出一个维护不起的 31k 行东西。

### D7 — 开发期加载 ✅
`cordis.patch.yml` 指向本地目录 + HMR（改完不重启）；验收前再走一次真实安装形态（`dsh plugin add` 本地路径）跑 AC16。

---

## 3.5 pi → DSH 配置字段对照表（实现时逐行对照）

| pi (`ServerEntry`) | 本插件 | 默认 | 说明 |
|---|---|---|---|
| `command` / `args` / `env` / `cwd` | 同名 | — | stdio；沿用 `dsh-mcp-client` 的 env 洗白 + 显式覆盖 |
| `url` / `headers` | 同名 | — | Streamable HTTP |
| `lifecycle` | 同名 | `lazy` | 4 值 |
| `idleTimeout` | 同名 | `10`（分钟，0=禁用） | 每服务器覆盖全局 |
| `requestTimeoutMs` | `toolCallTimeoutMs` | `60000` | 沿用 DSH 既有命名，减少认知负担 |
| `directTools` | 同名 | 缺省 = 不提升 | `true` / `string[]` / `"search"` |
| `includeTools` / `excludeTools` | 同名 | — | 名字或 glob，先在原始名上匹配 |
| `searchKeywords` | 同名 | — | 仅影响 `search` 排名，**绝不**进入 schema/描述/缓存 |
| `disabled` | 同名 | `false` | 仅字面 `true` 生效 |
| `toolPrefix` | 简化为 `serverName` 前缀规则 | — | pi 有 4 种前缀模式，v1 只保留一种确定命名 |
| `settings.idleTimeout` | 全局 `idleTimeout` | `10` | 插件级 config |
| `settings.freezeDirectTools` | 同名 | `false` | 冻结 direct **新增**以保前缀（撤销不受影响） |
| `settings.directTools` | 同名 | 缺省 | 全局缺省，被每服务器覆盖 |

---

## 4. 实现骨架

```
dsh-mcp-lazy/
├─ package.json          # type:module, dsh.bundle.patch, peerDeps: cordis / dsh-tools / dsh-subprocess …
├─ cordis.patch.yml      # - insert: [{ id: mcp-lazy, name: 'dsh-mcp-lazy' }]
├─ tsconfig.json         # 输出 lib/
├─ src/
│  ├─ index.ts           # Config schema（单服务器一条目）+ apply(): 注册代理工具、初始化 registry
│  ├─ registry.ts        # 多条目聚合：serverName → ServerState（配置哈希、缓存、生命周期）
│  ├─ server-manager.ts  # 懒连接 / inFlight / lastUsedAt / idle 回收 / 退避重连（改自 dsh-mcp-client）
│  ├─ transport.ts       # stdio(env 洗白) + streamable-http —— 直接改自 dsh-mcp-client
│  ├─ metadata-cache.ts  # 磁盘缓存：load/save/computeHash/isValid/reconstruct
│  ├─ search-ranking.ts  # 子串/正则 + 名称权重 + searchKeywords 加权（port 自 pi，重写非照抄）
│  ├─ proxy-tool.ts      # defineTool('mcp', …)：动作分发 + 结果投影（文本/图片）
│  └─ errors.ts          # 诊断文案：UNKNOWN_TOOL / AMBIGUOUS_TOOL / NOT_CONNECTED / SERVER_FAILED
└─ test/
   ├─ unit/*.test.ts     # 缓存失效、排名、idle 判定、命名歧义
   └─ e2e/*.test.ts      # 用 @modelcontextprotocol/server-everything / server-filesystem 真跑
```

**复用策略**：`dsh-mcp-client` 是 MIT（Copyright (c) 2026 DeepSeek），改自部分在文件头保留原版权声明 +
本插件 LICENSE 注明来源。连接/传输层尽量少改（那是踩过坑的代码），改动集中在「注册什么」。

**开发期加载**：profile 的 `cordis.patch.yml` 指向本地目录，走 HMR 热更（不动全局安装）；
验收 AC16 时再走一次真实安装形态。

---

## 4.5 M0 交付与证据（已落地）

代码位于本仓库（`src/` → `lib/`，`pnpm run check` 干净）。

| 已实现 | 说明 |
|---|---|
| `src/schema.ts` | 代理工具名、参数表、全部默认常量（**工具面由此定型，不依赖配置**） |
| `src/naming.ts` | `qualifiedToolName` / include-exclude / searchKeywords 解析 |
| `src/metadata-cache.ts` | 原子写、configHash 失效、7 天年龄上限、损坏即忽略 |
| `src/search-ranking.ts` | 加权排名（name 12 / original 10 / server 8 / desc 5 / kw 5）+ 词干匹配 + 分页 + 建议 |
| `src/registry.ts` | 多服务器视图、缓存水合、resolveInvoke（歧义/未知名/禁用三态）、生命周期解析 |
| `src/proxy-tool.ts` | `defineTool` 定义、动作分发、文本投影、失败降级为可读诊断 |
| `src/index.ts` | cordis 契约（`name` / `inject` / `Config` / `apply`），加载期校验且零 I/O |
| `scripts/link-dsh.mjs` | 把 peer 包链到**运行中的** harness 实例（避免 rc.1/rc.2 双实例） |
| `scripts/measure-surface.mjs` | 实测恒定 token 成本 |

**已验证的数字**

```
恒定模型可见面（每次请求都付）：工具名 mcp，参数 11 个，wire 1525 字节 ≈ 381 token
```

**已可运行的证据**

```bash
cd dsh-mcp-lazy
npm run check     # typecheck(src+test) + build
npm test          # 69 用例，覆盖 AC1/AC2/AC3/AC5(部分)/AC8/AC10/AC12/AC17(部分)/AC18
node scripts/measure-surface.mjs 3
```

**已知偏差**：`toolCallTimeoutMs` 沿用 DSH 命名（未采纳 pi 的 `requestTimeoutMs`）；
如需与 pi 配置逐字兼容，改 `src/types.ts` 字段名即可。

---

## 4.6 最终状态（M0–M5 全部落地）

代码：本仓库，`src/` 1778 → 2400 余行，测试 108 个用例全绿，`pnpm run check` 干净。

| 模块 | 职责 |
|---|---|
| `src/schema.ts` | 代理工具名与参数、全部默认常量 |
| `src/naming.ts` | 限定名、include/exclude、searchKeywords |
| `src/metadata-cache.ts` | 原子写、configHash 失效、7 天年龄上限 |
| `src/search-ranking.ts` | 加权排名、词干匹配、分页、建议 |
| `src/registry.ts` | 多服务器视图、缓存水合、解析三态、冷启动发现 |
| `src/connection.ts` | **懒连接**：按需 spawn、并发去重、空闲回收、取消、超时、断线清理、list_changed 刷新 |
| `src/direct-tools.ts` | 可选原生提升 + JSON Schema→DSL 转换 + freeze |
| `src/proxy-tool.ts` | 定义、动作分发、结果投影、失败降级为可读诊断 |
| `src/index.ts` | cordis 契约、装配、加载期零 I/O |

**实测成本**（`chrome-devtools-mcp@1.6.0`，29 工具）

```
原生注册  21252 字节 ≈ 5313 token
本插件     1525 字节 ≈  381 token
省下       92.8%
```

**过程中修掉的真 bug**（都由测试先红发现）

1. `includeTools: ['read_*']` 匹配不到 `srv__read_dir`（只比了完整限定名）。
2. 对 disabled 服务器 `connect` 会 throw，模型看到「工具失败」而非可读诊断。
3. npm 装了第二份 `dsh-tools`（rc.2 vs 运行时 rc.1），类身份不匹配隐患 → `scripts/link-dsh.mjs`。
4. `sweepIdle` 直接读窗口缓存而不是走解析器，导致**所有服务器都被当成「永不回收」**。
5. `mcp({ tool })` 要求目录已存在，冷启动时第一个调用必然失败 → `discoverAndResolve` 按需发现。
6. `defineTool` 收的是 DSL 不是裸 JSON Schema，原生提升静默失败 → `toParameterSpec` 转换器。
7. 刷新信号的订阅只有 `apply()` 里接了，测试与任何直接构造 registry 的调用方都不会收到 → 订阅改为 registry 自己拥有。

---

## 4.7 与 pi-mcp-adapter 对照后的修复（第二轮）

见 `parity-pi-mcp-adapter.md`：先做了一次逐模块功能对齐审计（四个只读切片 + 本机实测），查出 3 个缺陷与若干行为差异，随后按建议修掉。**这些改动没有一项移动模型可见的工具面**——仍是 1525 字节 / 11 参数 / 381 token。

| # | 改动 | 关键点 |
|---|---|---|
| 1 | 缓存过滤失效 | 过滤从写入路径移到读取路径；`#nameTools` 与 `#filterTools` 拆开；`configHash` 继续忽略过滤字段，但注释写明这只在「缓存存全量」时成立 |
| 2 | 搜索评分对齐 | `normalizeSearchText` 拆驼峰（在小写**之前**）；评分结构照 pi 重写；>2 token 的查询接受 60% 覆盖率 |
| 3 | 正则安全闸 | 256 字符上限 + 嵌套无界量词结构检测；被拒原因贯穿到模型（原先只显示「无匹配」） |
| 4 | 输出体量治理 | 新增 `src/output-guard.ts`：50 KiB / 2000 行上限，超出保留头部 + 全文落盘 0600 |
| 5 | 失败退避 + stderr | 60 秒抑制（显式 connect 可强制绕过）；stdio stderr 改 `pipe` 并保留有界尾巴；新增 `debug` 开关 |
| 6 | 冷缓存指引 | `mcp({})` 点名「无缓存」的服务器并给出 `connect` 动作；**未做**自动预热（与 AC2 冲突） |

**新增/变更的配置字段**：`server.debug`、`outputGuard`（全局）；`ServerStatus.failedAgoSeconds`（状态输出）。
**新增模块**：`src/output-guard.ts`、`test/unit/search-ranking.test.ts`、`test/unit/output-guard.test.ts`。
**测试**：110 → **179** 个用例，全绿；`pnpm run check`、`pnpm run test:types` 均干净。
**未变**：真实服务器省 token 仍是 `chrome-devtools-mcp@1.6.0` 的 **92.8%**（5313 → 381）。

**第二轮修掉的真 bug**

8. 缓存存的是**过滤后**的工具表，而 `configHash` 又忽略过滤字段 → **放宽 `includeTools`/`excludeTools` 永远不生效**，最长僵 7 天。真实进程端到端复现后修复，保留 2 个在旧代码上会变红的回归用例。
9. `normalizeSearchText` 不拆驼峰 → `getPixels` 用 `pixels` 搜不到。（第一版测试用了含 "pixel data" 的描述，靠描述词干匹配蒙对，掩盖了缺陷；换中性描述才复现。）
10. 正则无任何安全闸 → `(a+)+c` 对 28 字符重复串要 2 秒，指数增长，且搜索是**同步**跑在工具调用里的，会卡住会话。
11. 正则被拒时模型看到的是「No MCP tool matches」，会把「模式写错」误读成「工具不存在」。
12. stdio 未指定 `stderr`，SDK 默认 `inherit` 使 `transport.stderr` 为 `null` → 启动失败拿不到任何子进程诊断（写测试时才暴露）。
13. 4.5 节写的「文本超限走现有 spill 策略」是**错的**：`spill` 只在 bash / fs-search / pwsh / cordis 各自实现里，`dsh-tools` 与 `dsh-agent-loop` 没有框架级截断。

---

## 5. 验收标准（AC）

每条都必须**可执行、可观察**，并给出验证命令。`A` = 自动化测试，`M` = 人工/观测。

### 功能
- **AC1（A）** 冷启动零连接：配置 3 台服务器后启动 DSH，`ps` 中不出现任何 MCP 子进程，且日志无 `mcp__*` 工具注册。
- **AC2（A）** 工具面恒定（默认路径）：任何时刻（未连接/已连接/已回收/服务器增删工具后）`ctx.tools.schemas()` 中本插件贡献的工具**恒为 1 个**，名字与 JSON schema 逐字节相同。
- **AC2b（A）** direct 语义（仅当配置 `directTools`）：`true`/`string[]` 按选择注册真原生工具；`"search"` **只暂存（staged），不注册**，被 `mcp({ search })` 命中后才注册、并可直接调用。
  `freezeDirectTools: true` 时初始同步后的元数据更新**不扩大**工具面——它约束的只是**新增**，**不阻止撤销**：刷新后的 catalog 不再提供的工具照样从原生面收回（留着它只会拿服务器已删掉的名字去调用、每次都报错，比消失更伤模型），且被收回的名字之后即使回来也仍被拒绝，因为 freeze 管的是「增加」（`src/direct-tools.ts`）。
- **AC3（A）** 离线搜索：在**没有任何服务器进程**的情况下 `mcp({ search: "screenshot" })` 返回命中（来自磁盘缓存），且不产生 spawn。
- **AC4（A）** 懒启动：首次 `mcp({ tool, args })` 才 spawn；第二次命中复用同一连接（断言 pid 不变）。
- **AC5（A）** 元数据刷新：服务器变更工具列表（`notifications/tools/list_changed` 或重启后 `connect`）→ 缓存更新，`search` 结果随之变化。
- **AC6（A）** 空闲回收：把 `idleTimeout` 设为最小值，闲置到期后子进程退出、连接释放；再次调用能重新连上并成功。
- **AC7（A）** 在途保护：长调用期间即使超过 `idleTimeout` 也不回收（`inFlight>0`），调用正常完成。
- **AC8（A）** 错误面：未知名 / 歧义名（两台服务器同名工具）/ 服务器崩溃 → 三类确定性诊断文案，绝不返回伪造成功。
- **AC9（A）** 结果投影：文本按块序返回；图片**未实现，也不再计划实现**——投影层只输出一行诊断文本（类型 + 字节数），不转发像素（`src/projection.ts` 的 image 分支；口径以 `README.md`「Known Limitations」为准）。
- **AC10（A）** 分页：`search` 的 `limit`/`offset` 生效，默认 12、上限 40；超限被裁剪而非报错。

### 成本（本插件的存在理由）
- **AC11（M）** token 对比：同一组 3 台服务器，`dsh-mcp-client` 与 `dsh-mcp-lazy` 各跑一次相同会话，量出「工具定义占用 token」下降 ≥ 90%（基线用 `dsh-token-meter` 或请求体的 tools 段字符数）。
- **AC12（M）** 内存对比：同配置下 DSH 常驻 RSS 与 MCP 子进程数：冷启动为 0 个子进程；稳定态只在被调用过的服务器上 > 0。
- **AC13（M）** KV cache 稳定：连续多轮会话中，工具定义前缀不变（AC2 的运行时体现）；`mcp({ search })` / `mcp({ tool })` 的结果只追加在尾部。

### 工程质量
- **AC14（A）** `pnpm/npm run typecheck` 与 `build` 干净通过；`test` 全绿（含 AC1–AC10 的自动化用例）。
- **AC15（M）** README（中英）+ 配置目录齐全：每个 config 字段有默认值与含义；「Known Limitations」明确列出 D6 的未做项。
- **AC16（M）** 可卸载性：删掉插件条目后 DSH 正常启动，无残留工具、无孤儿进程、无残留缓存文件被读取。
- **AC17（A）** 与官方插件**不冲突**：同时挂载 `dsh-mcp-client`（不同 `serverName`）时两者各自工作；`serverName` 重复时本插件明确报错而非静默覆盖。
- **AC18（M）** 沙箱/安全：stdio 子进程 env 仍按 `dsh-mcp-client` 的洗白规则（丢 `KEY|PASSWORD|SECRET|TOKEN` 与 `DSH_*`），显式 `env` 覆盖生效。

### 明确不阻塞验收（v1 允许缺）
- 服务器工具数 0 台时的面板/UI 呈现；OAuth 交互；prompts/resources 桥接。

---

## 6. 里程碑

| # | 交付 | 出口判据 |
|---|---|---|
| M0 | 骨架 + 单代理工具注册（无连接） | ✅ **已完成** — 69 个自动化用例全绿；实测恒定成本 **381 token** |
| M1 | 缓存层 | ✅ **已完成**（与 M0 同步落地）— AC3 通过，冷缓存路径亦有覆盖 |
| M2 | 懒连接 + 调用 | ✅ 已完成 — AC1、AC4、AC8、AC9 通过（真实进程） |
| M3 | 生命周期（空闲回收） | ✅ 已完成 — AC6、AC7 通过。**断线重连未实现，也不在计划内**：`src/index.ts:95` 写明本插件没有重连定时器，掉线的服务器由下一次需要它的调用重新拉起，启动失败的服务器只等失败退避窗口；`reconnect` 字段被明确拒绝并给出替代做法 |
| M4 | 刷新 / 分页 / 冲突语义 / directTools | ✅ 已完成 — AC5、AC10、AC17、AC2b 通过 |
| M5 | 成本度量 + 文档 | ✅ 已完成 — AC11 实测 92.8%；AC12/AC18 有测试 |

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 动态工具注册 vs KV cache | 省钱反被 cache 击穿 | 默认恒定单工具（AC2 守住）；directTools 为显式可选 + `freezeDirectTools` 约束增长（撤销仍会改变工具面） |
| fork 上游漂移 | 官方修 bug 拿不到 | 只改「注册什么」，连接/传输层保持与上游 1:1，便于 rebase；记录 upstream 版本 |
| 缓存陈旧导致模型按旧 schema 调用 | 调用失败 | 缓存带 `configHash` + TTL；`mcp({ tool })` 前对未知工具做一次实时校验；失败信息给出刷新动作 |
| 代理工具 schema 过大 | 恒定成本上升 | `mcp` 工具参数保持扁平（tool/args/server/search/describe/limit/offset），实测目标 ≤ 400 token |
| 空闲回收误杀长任务 | 数据/进度丢失 | `inFlight` 计数（AC7）+ 关闭前 quiesce |
| 与官方 MCP 插件并存时的命名 | 工具名冲突 | 各自 `serverName` 命名空间；重复即报错（AC17） |
| `"search"` 模式激活导致前缀变化 | 命中那一刻 cache 失效 | 激活只发生一次且由模型搜索触发；文档写明；`freezeDirectTools` 冻结**新增**（服务器的撤销不受它影响） |
