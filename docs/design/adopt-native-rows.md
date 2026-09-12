# dsh-mcp-lazy — 接管命令（adopt）方案与验收标准

**状态**：方案，**未实施**。本文件只定义要做什么、如何判定做完，不含实现代码。
**本仓库版本**：`0.1.1`（`package.json`）。
**范围**：B 路线 —— 显式接管命令。A 路线（劫持 `@deepseek-ai/dsh-mcp-client` 包名）不在本次范围，理由见 §7。
**取证对象与版本**（第三方包升级后需重新核对本文全部行号）：

| 包 | 版本 | 路径 |
| --- | --- | --- |
| `@deepseek-ai/cordis-plugin-loader` | `1.0.3` | `~/.bun/install/global/node_modules/@deepseek-ai/` |
| `@deepseek-ai/dsh-app-boot` | `0.1.5-rc.1` | 同上 |
| `@deepseek-ai/dsh-mcp-client` | `0.1.5-rc.1` | 同上 |
| `@deepseek-ai/dsh-tools` | `0.1.5-rc.1` | 同上 |
| `dsh-config-manager` | `0.1.57` | `~/.dsh/profiles/web/node_modules/` |
| `@hyzyn/dsh-codegraph` | `0.1.9` | 同上 |

---

## 1. 问题陈述（已验证的事实）

本插件存在的理由是「让 MCP 工具的 schema 不进每次请求」。生态里写 MCP 配置的各方却**只产出 `@deepseek-ai/dsh-mcp-client` 行**，于是同一台服务器被两个插件同时注册：工具不冲突、不报错，但省 token 的效果静默归零（`src/proxy-tool.ts` 的冲突提示即为此而写）。

| 编号 | 事实 | 取证 | 复现命令 |
| --- | --- | --- | --- |
| F1 | `dsh-config-manager` 的 MCP 面板读写 `dsh-mcp-client` 行，**目标文件是 home 层** `$DSH_HOME/cordis.patch.yml` | `lib/adapters/mcp.js:87,103,152`；`USER_PATCH_FILE` 定义于 `lib/adapters/plugins.js:11`；路径映射 `lib/index.js:569-573`。注意 `lib/adapters/mcp.js:3` 的注释自称写 profile 层，**与代码不符** | `rg -n "USER_PATCH_FILE\|name: 'dsh-mcp-client'" ~/.dsh/profiles/web/node_modules/dsh-config-manager/lib/` |
| F2 | `@hyzyn/dsh-codegraph` 硬编码同一包名，并向 home 层写入托管行 | 常量 `lib/index.js:36`、行构造 `:208-217`（`name` 在 `:210`）、落盘 `:238-250`（临时文件 `:243`） | `rg -n "MCP_CLIENT_PACKAGE" ~/.dsh/profiles/web/node_modules/@hyzyn/dsh-codegraph/lib/index.js` |
| F3 | 模型（agent）同样按惯例把新 MCP 服务器配到 `dsh-mcp-client` 行 | **仅记录，非已验证事实**：本机发生过一次，纠正过程见 §1.1 | — |
| F4 | 本插件对同装于 `dsh-mcp-client` 的服务器已有检测，但结果在 `apply` 时被快照，**仅当改动落在 home 层时才陈旧** | 检测定义 `src/index.ts:206`；快照调用点 `src/index.ts:371`；承接参数 `src/proxy-tool.ts:131`；机制见 §1.2 | §1.2 |
| F5 | 检测读的是 loader 的声明树（`loader.entries()`），不是运行时状态，因此不依赖插件应用顺序 | `src/index.ts:200-201`（注释）、`:217-228`（实现） | `sed -n '194,229p' src/index.ts` |
| F6 | 两个插件的 server 字段**同义**，本插件的 server 条目可直接承接 `dsh-mcp-client` 的 `config` | `src/types.ts:5`；对方 schema `@deepseek-ai/dsh-mcp-client/lib/index.js:743-760`。两处真实差异见 §1.4 | `sed -n '1,12p' src/types.ts` |
| F7 | `dsh-mcp-client` 独有字段在本插件会被**拒绝并报错**，而不是忽略 | 定义 `src/index.ts:84`；抛出点 `:277` | `sed -n '84,95p;270,280p' src/index.ts` |
| F8 | loader 提供公开的条目改写 API：合并新 options、按需重启、并持久化回其来源层 | `@deepseek-ai/cordis-plugin-loader/lib/types/config/entry.d.ts:47-48` | `sed -n '44,49p' ~/.bun/install/global/node_modules/@deepseek-ai/cordis-plugin-loader/lib/types/config/entry.d.ts` |
| F9 | 条目支持 `disabled` 声明（`boolean \| null`），且接受 `!!js` 表达式；**原始节点保留在 options 里，写回时保持该写法** | 字段 `entry.d.ts:16`；`!!js` 求值语义 `:38-42` | `sed -n '14,17p;36,43p' ~/.bun/install/global/node_modules/@deepseek-ai/cordis-plugin-loader/lib/types/config/entry.d.ts` |
| F10 | 本插件的**代理工具**名是单例 `mcp`，全插件只有一处注册点（`:348` 的另一处属 direct-tools 回调） | `src/schema.ts:15`；注册点 `src/index.ts:366` | `rg -n "PROXY_TOOL_NAME" src/schema.ts src/index.ts` |
| F11 | patch 是**按 id 匹配的覆盖操作列表**，不是配置；四层依次应用，**找不到 id 只 warn 并跳过，不报错** | `dsh-app-boot/lib/index.js:59-108`（`applyEntryPatches`；`insert` 展平于 `:86`；未命中警告 `:93-97`）；层顺序 `[...bundlePatches, ...profile.patches, ...homePatches, ...overlays]`，见 `dsh/lib/profile-boot-Dk-7KqJc.js:215-218` | `sed -n '59,108p' ~/.bun/install/global/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` |
| F12 | patch 的 `config` 覆盖是**整体替换，没有深合并** | `dsh-app-boot/lib/index.js:104`（`target[key] = value`）；实机文件自己的注释记着这条坑（`~/.dsh/profiles/web/cordis.patch.yml:8-9`） | 同 F11 命令 |
| F13 | 同一 scope 内重复注册同名工具会**直接抛错** | `@deepseek-ai/dsh-tools/lib/index.js:2538`（`NamedEntries(name => new Error('tool "${name}" is already registered in this scope'))`） | `sed -n '2536,2541p' ~/.bun/install/global/node_modules/@deepseek-ai/dsh-tools/lib/index.js` |

### 1.1 F3 的记录（不作为已验证事实）

接入 `computer-use-linux` 时，agent 把新行写进了 `name: '@deepseek-ai/dsh-mcp-client'`；而同一台机器上 `dsh-mcp-lazy` 已配置、用户意图明确为「MCP 走懒加载」。纠正后该服务器改为 `dsh-mcp-lazy` 的 `servers` 条目。

这段只说明**缺少一条把「写配置的一方」与「用户的通道选择」连起来的路径**，不构成可复现证据。它不作为任何设计决策的依据。

### 1.2 F4 的机制：陈旧只在改动 home 层时发生

`web` profile 的 `patchReload` 为 `live`（`dsh-app-boot/lib/index.js:330-335`）。因此：

| 改动落点 | loader 行为 | 冲突名单 |
| --- | --- | --- |
| **profile 层**（如 `mcp-lazy` 的 `servers`） | 该行 `config` 变化 → fiber 重跑 `apply` | **会刷新**，无陈旧 |
| **home 层**（生态写的 `dsh-mcp-client` 行） | 只重组树（`watchUserPatches` `:1109-1120` → `entry.update({config:{patches}})`） | **陈旧**，不重算 |

本机实测到的陈旧现象对应的是 home 层改动（把 phonemcp 从 home 层迁到 profile 层后，网关状态仍列出它）。**任何覆盖 F4 的测试都必须写死改的是哪一层。**

### 1.3 迁移的收益量级（估算，非判定依据）

| 服务器 | 工具数 | schema 体量 | 折算 |
| --- | --- | --- | --- |
| `phonemcp` | 16 | 6,652 字节 | ≈ 1,663 token / 请求 |
| `computer-use-linux` | 18 | 16,803 字节 | ≈ 4,200 token / 请求 |
| 合计 | 34 | 23,455 字节 | **≈ 5,860 token / 请求** |

数字来自本机 `mcp-lazy` 元数据缓存（`~/.dsh/storages/mcp-lazy/cache.json`）的 schema 序列化字节数，按 4 字节/token 折算。**这是估算**：`scripts/measure-token-savings.mjs` 只接受 `--npx <package>` 指定的服务器，无法直接复现这两个数字。验收不依赖该折算，只依赖「schema 不再进入请求」这一可判定事实（AD8）。

### 1.4 F6 的两处真实差异

`dsh-mcp-client` 的 `Config`（`lib/index.js:743-760`）与 `src/types.ts:48-102` 逐字段核对后，除 F6 所述的同义性外有两处差异，接管时必须有明确行为：

1. **`cwd` 默认值不同**：对方 `cwd: z.string().default("")`（`:749`），组合后可能是空串 `''`；本插件 `cwd` 无默认（`src/index.ts:100`）。「原样搬运」会把 `cwd: ''` 搬进来，语义上应视同未设置。
2. **重复 `serverName` 双方都抛错**：对方 `:779`，本插件 `src/index.ts:264-268`。因此「同一个 serverName 出现在多处」在 mcp-client 侧本来也起不来，接管计划需要把它归入明确的一类（§3）。

---

## 2. 设计决策

**D1、D2 已于 2026-09-13 定案**，D3–D8 为既定设计，本文件当前无待决项。

### D1 — 命令形态：仓库内脚本 ✅ 已定

**决策**：实现为 `scripts/adopt.mjs`。

| 候选 | 结论 | 理由 |
| --- | --- | --- |
| **(a) 仓库内脚本** | **采纳** | 与 `scripts/measure-*.mjs` 同构；不需要宿主运行；可进 CI 与文档；配置手术离线做最安全 |
| (b) 宿主内工具或斜杠命令 | 不采纳 | 需要宿主在跑；「工具改用户配置」需要额外的确认设计 |
| (c) GUI 卡片按钮 | 不采纳 | 依赖第三方卡片生态，收益与成本不成比例 |

### D2 — 写回策略：文本级改写 ✅ 已定

**决策**：按行文本改写 patch 文件。

| 候选 | 结论 | 理由 |
| --- | --- | --- |
| **(a) 文本级改写 patch 文件** | **采纳** | 要保留注释、空行与 `!!js` 表达式的**原样字节**，任何 dump→parse→dump 都会丢掉它们 |
| (b) 调 `Entry.update()` 让 loader 持久化 | **不采纳** | 见下方 P0 级风险 |

**D2(b) 的具体危险**（原本只是「格式未知」，实测取证后升级为不采用）：`Entry.update` 最终调用 `tree.write()`（`cordis-plugin-loader/lib/index.js:691-698`、`:266`），root include 的 `write()` 写的是**底文件** `cordis.yml`（`dsh-app-boot/lib/index.js:1335-1342`），而写入内容是 `root.data` —— **打过全部 patch 的组合结果**（`:237-243`）。后果是所有层的行被展平进 `cordis.yml`，而 patch 层下次仍会再 `insert` 一遍（`:86` 无去重）→ 同 id 重复行。

关于依赖：本仓库运行时依赖只有 `@modelcontextprotocol/sdk` 一个（不变量 I7 核验），但 `scripts/` 不在运行时路径上，把解析器放进 `devDependencies` **并不违反该不变量**。选 (a) 的真实理由是**字节保真**，与依赖数无关。

### D3 — 禁用方式：**就地**加 `disabled: true` ✅ 已定

**决策**：在被接管的那一行**内部**增加 `disabled: true`，而不是在别处追加一条同 id 的覆盖条目。

```yaml
# 改前
- insert:
    - id: mcp-codegraph-managed
      name: '@deepseek-ai/dsh-mcp-client'
      config: { ... }
# 改后：只加一行
- insert:
    - id: mcp-codegraph-managed
      name: '@deepseek-ai/dsh-mcp-client'
      disabled: true          # ← 就地新增
      config: { ... }
```

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| **就地加 `disabled`** | **采纳** | ① 不依赖层顺序（F11 的陷阱消失）；② 经 `dsh-config-manager` 重写后仍成立（该插件按 id 建表、**同 id 只保留第一行**，见 §6）；③ 目标行本就不在 I4 的保护范围内 |
| 追加同 id 覆盖条目 | 不采纳 | ① 生效条件实为**图层顺序**而非数组顺序（F11）：生态写的行在 home 层，若覆盖写进 profile 层，处理时目标尚未 insert，loader 只打一条 warning，**原行照旧启用、退出码仍是 0**；② 会被 config-manager 的整份重写按 id 去重吞掉 |

代价：回滚只能靠备份（D6）或依赖 codegraph 重写（§8 V3）。取舍是可接受的 —— 备份本来就要做。

### D4 — 检测时机（修 F4）

把 `detectNativelyRegistered(ctx)` 由「`apply` 时算一次」改为「每次渲染网关状态时现算」。

**接口影响（必须一并处理）**：`createProxyTool(..., nativeServers: readonly string[])` 接收的是**值**而非 getter（`src/proxy-tool.ts:429-434`，`executeProxy` 第 6 参 `:299`），而 `createProxyTool` 是**已发布的公开导出**（`src/index.ts:411`、`package.json` 的 `exports` → `lib/index.d.ts`）。改签名属于破坏性变更，会波及 `scripts/measure-surface.mjs:38` 与 `test/unit/plugin-load.test.ts` 里传数组的用例。可选实现：把参数改为 `() => readonly string[]`（惰性求值），并保留旧签名重载一个版本。

### D5 — 默认不写盘

默认 dry-run；必须显式给出 `--write` 才落盘。

### D6 — 备份与回滚

写回前备份为 `<file>.bak-<yyyymmdd-hhmmss>-before-adopt`。备份清单按**实际被写的文件**逐项列出（home 层与 profile 层都可能被写，见 F11）。同目录既有两种命名（`cordis.patch.yml.bak-223656-before-browser` 与 `cordis.patch.yml.bak-20260911-210714`），本文档统一采用带日期的后一种。

### D7 — 幂等：拆成两个独立判定

原先的「已在 `servers` 中则跳过」有一个漏洞：**serverName 已在本插件 `servers` 里、同时仍存在一行 native 行**，恰恰是最该去禁用原行的情况，而「跳过」会把禁用也一起放过。因此拆成：

| 判定 | 作用范围 |
| --- | --- |
| `skip`（`already-lazy`） | 只表示**不再新增** `servers` 条目 |
| `overrides`（就地禁用） | 只要存在 native 行**且**其 serverName 已被本插件接管，就要禁用该行 |

### D8 — 明确不做的迁移对象

`@hyzyn/dsh-codegraph` 的托管行会被插件自身重写（F2）。接管它需要同时把该插件的 `mcpIntegration` 设为 `false`，属跨插件协同动作，不进 v1（§7）。

---

## 3. 接口与接缝

### 3.1 读路径：以 `dsh --dump-config` 为真相源

patch 文件是**操作列表**（F11），「现在到底配了什么」是四层依次应用的结果（含同 id 覆盖、`insert` 展平、`!!js`），一个只做「识别 + 追加」的行解析器**算不出**这个结果 —— 而 D7 的幂等判据正依赖它。

因此读路径改为调用：

```
dsh --profile web --dump-config
```

依据：它**不 boot、不求值 `!!js`**（`dsh/lib/dump-config-lFgMwK8i.js:8-10`），走的是同一个 `applyEntryPatches`，是离线且权威的真相源。写路径仍回到文本级、只改一处。

### 3.2 写路径的两条硬规则

1. **就地改写**：只修改承载该行的那个文件、那一行；不追加同 id 条目（D3）。
2. **`config` 是整体替换**（F12）：若需要往 `mcp-lazy` 追加 server，必须**就地改写现存那一行 `config.servers` 列表**；追加一条新的 `- id: mcp-lazy` 会清空 `idleTimeout`、`outputGuard` 与另外 5 台服务器。

### 3.3 纯函数（`src/adopt.ts`）

值一律以**原文片段**传递：`!!js` 在 loader 方言里是表达式节点（`dsh-app-boot/lib/index.js:19-24`，`yaml.JSON_SCHEMA.extend(JsExpr)`），解析后无法无损还原。含 `!!js` 的 server 条目要么原样搬运 raw text，要么进 `skip`。

```ts
export interface NativeRow {
  id: string
  /** 缺失时用 undefined；'(unnamed)' 不再作为哨兵值（见 §3.5）。 */
  serverName?: string
  /** 原始 YAML 片段，逐字节保留。 */
  raw: string
  layer: 'home' | 'profile'
  file: string
}

export type AdoptSkipReason =
  | 'already-lazy'        // 已在 servers 中：不再新增条目（但禁用仍要做，见 D7）
  | 'missing-server-name'
  | 'unsupported-field'   // reconnect / failOnStartupError（F7）
  | 'duplicate-native'    // 同一 serverName 出现多行（对方也会抛错，§1.4）
  | 'js-expression'       // 含 !!js，v1 不搬运

export interface AdoptPlan {
  adopt: Array<{ source: NativeRow; entry: ServerEntryInput }>
  disable: Array<{ id: string; file: string; line: number }>
  skip: Array<{ source: NativeRow; reason: AdoptSkipReason; detail?: string }>
  /** 每个待写文件的插入区间，供 AD4 做字节级断言。 */
  edits: Array<{ file: string; start: number; end: number; replacement: string }>
}

export function planAdoption(
  composed: readonly NativeRow[],
  existingServers: readonly ServerEntryInput[],
): AdoptPlan
```

### 3.4 CLI 与退出码

```
node scripts/adopt.mjs [--profile web] [--dsh-home <path>] [--file <path>]
                       [--write] [--json] [--allow-skip]
```

| 参数 | 作用 |
| --- | --- |
| `--dsh-home <path>` | 覆盖 `$DSH_HOME`（AC11、AC5 需要指向副本） |
| `--file <path>` | 只处理指定的 patch 文件（隔离测试用） |
| `--json` | 输出机器可读计划，含 `edits` 区间与 `wrote` 标志 |
| `--allow-skip` | `skip` 非空时不视为失败 |

| 退出码 | 含义 |
| --- | --- |
| `0` | 无待处理项，或 dry-run 成功，或 `--write` 成功 |
| `1` | `skip` 非空且未指定 `--allow-skip` |
| `2` | 环境错误：文件不可读/不可写、结构无法识别、**写前 sha256 校验失败**（并发修改）。此时**零写入** |

### 3.5 边界语义

| 情形 | 行为 |
| --- | --- |
| 行存在但缺 `serverName` | `skip: 'missing-server-name'`。注意对方 `serverName` 是 required（`dsh-mcp-client/lib/index.js:745`），这类行本来也起不来 |
| 同一 serverName 多行 | `skip: 'duplicate-native'`（§1.4） |
| 同名 server 分布在 home 与 profile 两层 | 按 `applyEntryPatches` 的 id 表语义，后层覆盖前层 → 只有一行的语义生效；计划中标注实际生效的文件 |
| `--patch <path>` 覆盖层 | **v1 不处理**；检测到该层含 `dsh-mcp-client` 行时必须在计划里报出，不静默（§7） |
| 含 `!!js` 的 server 条目 | `skip: 'js-expression'`（v1） |
| `cwd: ''` | 视同未设置，不搬运空串（§1.4） |
| `transport: 'sse'` | 不可能出现：对方只支持 `stdio` / `streamable-http`（`:743-760`），故不设该 skip 原因 |

### 3.6 写入的原子性与并发

`dsh-config-manager` 是整份重写，本命令也是 → 后写的赢、先写的静默丢失。要求：

1. 写前记录目标文件 `sha256`，写入前重新校验；不一致则退出码 2。
2. 写入用 tmp + rename 原子替换。
3. 文档中建议**在宿主停机时执行**（`web` profile 的 `patchReload: live` 会立即重组树）。

---

## 4. 不变量

| 编号 | 不变量 | 核验 |
| --- | --- | --- |
| I1 | 模型可见工具面保持 **1525 字节 / 11 参数 / 381 token** | 测试：`node scripts/measure-surface.mjs` |
| I2 | 不运行接管命令时，插件行为与本版本逐项一致 | 测试：现有 8 个测试文件全绿 + AD7 的反向断言 |
| I3 | 非目标行（手工行、`rtk` 行、注释、空行）**逐字节不变**；目标行允许新增 `disabled` 一行 | 测试：AD4 的字节级比对 |
| I4 | 接管后，被接管的服务器仍可被调用，行为与接管前一致 | 测试：组件 e2e（真子进程 fixture） |
| I5 | `check` 的阶段顺序不变：`typecheck` → `build` → `test:types` | 人工核对：`jq -r '.scripts.check' package.json` |
| I6 | 新增测试一律落在 `test/unit/*.test.ts`，`pretest`（build + link-dsh）仍通 | 人工核对：`jq -r '.scripts.pretest' package.json` |
| I7 | 运行时依赖仍为 1 个（`@modelcontextprotocol/sdk`） | 人工核对：`jq '.dependencies' package.json` |
| I8 | **公开导出面不破坏**：`src/index.ts:411` 导出的 `createProxyTool` / `McpGatewayRegistry` / `LazyConnections` / `OutputGuard` / `PROXY_TOOL_NAME` 属已发布 API（`package.json` 的 `exports` → `lib/index.d.ts`）。D4 若改 `createProxyTool` 第 4 参属破坏性变更 | 人工核对：对比 `lib/index.d.ts` 导出清单 |
| I9 | **配置语义可往返**：接管后的文件经 `dsh-config-manager` 写回一次，`disabled` 语义仍成立、`mcp-lazy.servers` 不丢 | 测试：模拟一次整份重写后重新组合 |
| I10 | **发布物边界**：`scripts/adopt.mjs` 会随包发布（`package.json` 的 `files` 含 `scripts`、`src`）—— 要么承认它是发布物，要么在 `files` 中排除 | 人工核对：`jq '.files' package.json` 与 `npm pack --dry-run` |

---

## 5. 验收标准（AD）

本文档的验收标准使用 `AD` 前缀编号，与 `docs/design/plan.md` 的 `AC` 编号互不冲突 —— 后者已被 `docs/troubleshooting.md` 等文档实际交叉引用，沿用同一序列会造成指向歧义。

`A` = 自动化（落 `test/unit/*.test.ts`，命令格只允许仓库内可执行命令）；`M` = 人工/观测。两类都必须在仓库根可执行。判定命令中的 `pnpm test` 已带 `pretest`（构建 + relink peers）。

| 编号 | 标准 | 判定命令 | 期望输出 |
| --- | --- | --- | --- |
| AD1（A） | dry-run 零写入 | 记录目标文件 `sha256sum` + `stat -c '%Y %s'` → `node scripts/adopt.mjs` → 再记录一次 | 无待处理项时退出码 0；有待处理项时打印计划；两次摘要与 mtime 完全一致。**不使用 `git diff`**：`~/.dsh` 不是 git 仓库（实测 `git -C ~/.dsh diff` 报「不是 git 仓库」） |
| AD2（A） | `--write` 后语义生效 | `node scripts/adopt.mjs --write` → `dsh --profile web --dump-config` | 组合结果中该条目的 `disabled` 为真，且 stderr **无** `patch: entry ... not found` 警告（F11 的静默失效指纹） |
| AD3（A） | 幂等 | 连续执行两次 `--write` | 第二次计划为空、退出码 0、文件字节不变；第二次**不产生新备份** |
| AD4（A） | 非目标行逐字节不变 | 用 `--json` 输出的 `edits` 区间做断言：`原文件 == 新文件删掉这些区间后的字节` | 完全相等。**不靠人工「排除新增段」** |
| AD5（A） | 不支持的字段被拒绝而非静默丢弃 | 用 `contextWithLoader` 造一条含 `reconnect` 的行，调 `planAdoption` | 该条进入 `skip`，原因 `unsupported-field` |
| AD6（A） | 检测不再陈旧（修 F4） | 单测：`plugin-load.test.ts` 的 `contextWithLoader(entries)` + 渲染状态；**必须分两个用例** —— 改 profile 层（本就不陈旧）与改 home 层（原缺陷） | 两种情况下列表都与声明树一致。`mcp({})` 是模型侧工具调用，不能作为判定命令 |
| AD7（A） | 被禁用的条目不再启动（「什么都没发生」断言） | 先经组合造出带 `disabled` 的树，再用 fixture 的 `FIXTURE_START_COUNT`（`test/fixtures/mcp-server.mjs:11,29`）计数 | 被禁用条目的启动计数为 **0**；未禁用的对照组 > 0 |
| AD8（A） | 工具面不变量 | `node scripts/measure-surface.mjs` **加上**一条经 `apply()` 注册出的工具定义字节断言（`measure-surface.mjs` 只 import `lib/proxy-tool.js` + `lib/registry.js`，绕开 `apply()`，对 `src/index.ts` 零灵敏度） | 与本文件 I1 的三项数字逐字节一致，且经 `apply()` 的那条也一致 |
| AD9（A） | 备份与回滚 | `ls ~/.dsh/cordis.patch.yml.bak-*-before-adopt`（按**实际被写的文件**逐项）；用备份覆盖后重跑 `dump-config` | 备份存在；恢复后组合结果与接管前一致 |
| AD10（M） | 真实宿主端到端 | 在隔离 profile 上执行接管 → `dsh --profile web --dump-config` | 该服务器出现在本插件 `servers` 下，原条目 `disabled`，且进程数不增 |
| AD11（A） | 错误路径零写入 | `node scripts/adopt.mjs --dsh-home <只读副本> --write` | 退出码 2，打印原因，副本未被修改 |
| AD12（A） | 验红记录 | 每条新增回归测试都要有一次「修复前失败」记录 | 失败输出含测试名与断言行；**并注明改的是 `src/` 还是 `lib/`**（测试跑构建产物，改 `src/` 不构建不会变红） |
| AD13（A） | 干净环境复现 | `rm -rf lib node_modules && pnpm install --frozen-lockfile && pnpm run check && pnpm test` | 全部通过（与 `docs/development.md` 的命令一致） |
| AD14（A） | 配置往返（I9） | 接管 → 模拟 `dsh-config-manager` 整份重写 → 重新组合 | `disabled` 仍生效，`servers` 未丢，`idleTimeout` / `outputGuard` 未丢 |
| AD15（M） | 并发保护 | 写入前后人为改动目标文件 | 退出码 2，零写入 |

### 明确不阻塞验收（v1 允许缺）

- 不处理 `--patch` 覆盖层里的 `dsh-mcp-client` 行（仅在计划里报出）。
- 不处理含 `!!js` 的 server 条目。
- 不要求 GUI 入口。
- `url` / `headers` 原样搬运即可，不做传输改造。
- 不迁移 `@hyzyn/dsh-codegraph` 的托管行（D8）。

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 改写用户唯一的配置文件 | 配置损坏后 MCP 全挂 | 默认 dry-run（D5）；写前备份（D6）；AD11/AD15 断言错误路径零写入 |
| 禁用写在错误的层 → **静默失效**（F11） | 双跑继续、省 token 归零，而脚本报成功 | D3 改为就地改写，从根上避开层顺序；AD2 额外断言 stderr 无 `not found` 警告 |
| 追加同 id 条目导致 `config` 被整体替换（F12） | `idleTimeout`、`outputGuard` 与另外 5 台服务器消失 | §3.2 规则 2；AD14 覆盖 |
| `dsh-config-manager` 整份重写吞掉接管结果 | 用户从 GUI 走一次导入/写回后接管失效且无提示 | D3 就地改写（同 id 唯一，去重不会丢）；AD14 断言往返 |
| 与 config-manager 并发写 | 后写的赢，先写的静默丢失 | §3.6 的 sha256 校验 + tmp/rename；文档建议停机执行 |
| 陈旧名单导致漏接管或重复动作（F4） | 命令结果与网关提示不一致 | D4 先修；AD6 分两层用例覆盖 |
| `!!js` 表达式在文本级改写中被破坏 | 该服务器永久禁用或加载失败 | 值以 raw text 传递；含 `!!js` 的条目 v1 直接 skip（§3.3） |
| D4 改 `createProxyTool` 签名 | 破坏已发布的公开 API（I8） | 用惰性 getter 并保留旧签名重载；I8 列入核对清单 |
| 既有测试断言「激活时必须安静」 | 回归逃逸 | AD7 同时验两个方向：默认安静、显式开启后动起来 |
| 第三方包升级 | 本文行号与 API 假设失效 | 头部已固定取证版本；升级后重跑 §1 的复现命令 |

---

## 7. 明确不做（v1 边界）

1. **不劫持包名**。把 `@deepseek-ai/dsh-mcp-client` 解析到本插件能让全世界写的行自动走懒加载，但代理工具名是单例 `mcp`（F10），且同 scope 重名会直接抛错（F13）：N 个 `dsh-mcp-client` 行 = N 个插件实例 = N 次注册同名工具 → 直接失败。要落地必须先做**模块级单例 registry**，属架构级改动。
2. **不在插件启动时自动接管**。
3. **不做 GUI**。
4. **不迁移 `@hyzyn/dsh-codegraph` 的托管行**（D8）。
5. **不处理 `--patch` 覆盖层**：它是合法层（`dsh --help:15-16`），但 v1 只在计划里报出，不读写。
6. **不为 `dsh-mcp-client` 添加本插件不支持字段的实现**（`reconnect`、`failOnStartupError`）。

---

## 8. 实施前必须补的验证

| 编号 | 待验证 | 验证方式 |
| --- | --- | --- |
| V1 | `Entry.update()` 究竟会把什么写进哪个文件（D2(b) 的危险已由源码推断，但未实测） | 在隔离 profile 上调用并 `git diff` 前后比对。**注意：D2 已定案不采用 (b)**，此项仅为记录风险，不阻塞实施 |
| V2 | ~~`disabled` 覆盖是否按数组顺序匹配~~ | **因 D3 改为就地改写而作废**：不再依赖层顺序。F11 的层序知识仍需保留（解释为何不能追加覆盖） |
| V3 | 被禁用的 `dsh-codegraph-managed` 行是否会被该插件重写回来 | 禁用后触发一次 codegraph 同步，`git diff` 观察 |
| V4 | `dsh --profile web --dump-config` 对 `disabled` 条目的呈现形式（AD2、AD10 依赖它） | 在带禁用条目的隔离 profile 上执行 |
| V5 | ~~「同层重名工具注册会失败」~~ | **已由源码验证**（F13，`dsh-tools/lib/index.js:2538`），无需实测；实测可选 |
| V6 | 行解析器的最小充分文法；解析器需同时识别 `dsh-mcp-client` 行与本插件的 `servers` 数组 | 对两个真实 patch 文件跑解析并断言 round-trip 一致。**本机现状实测**：home 层 34 行、0 处 `!!js`、4 处块式数组；profile 层 98 行、**5 处 `!!js`**、1 处流式数组 `[...]`、16 处块式数组；缩进层级覆盖 0/2/4/6/8/10 |

---

## 9. 里程碑

| 阶段 | 内容 | 出口判据 |
| --- | --- | --- |
| M0 | 补 §8 的 V3、V4、V6（V1 不阻塞、V2 作废、V5 已验） | 三条各有一条可复现命令与实测输出归档到本文件 |
| M1 | 修 F4（检测现算）+ 回归测试；处理 D4 的公开 API 影响 | AD6、AD8、AD12 |
| M2 | `src/adopt.ts` 纯函数 + 单测 | 单测覆盖 adopt / disable / skip 三类分支，每条留验红记录 |
| M3 | `scripts/adopt.mjs` dry-run（含 `--json`、`--dsh-home`） | AD1、AD4、AD5、AD11 |
| M4 | `--write` + 备份 + 并发校验 | AD2、AD3、AD9、AD14、AD15 |
| M5 | 宿主集成验证 | AD7、AD10、AD13 |
| M6 | 文档与发布 | README/README-zh 增补命令说明；`docs/configuration.md` 增补接管的取舍；`package.json` 的 `files` 决定是否发布 `scripts/adopt.mjs`（I10）；CHANGELOG 记录 |

---

## 10. 修订记录

**2026-09-13 — 独立评审后修订（本轮）**。评审为只读，未修改任何文件；其 P0 级结论已由作者独立复核（`applyEntryPatches` 实现、层顺序数组、`dsh-tools` 重名断言均已现场验证）。修订内容：

| 类别 | 修订 |
| --- | --- |
| 写路径 | 新增 F11/F12 两条事实；§3 补「就地改写」与「`config` 整体替换」两条硬规则；**D3 由「追加覆盖条目」改为「就地加 `disabled`」** |
| 读路径 | 由「自写行解析器读 patch」改为「以 `dsh --dump-config` 为真相源」（§3.1） |
| 决策 | D2(b) 由「格式未知」升级为**明确不采用**并附证据链；D7 拆成 `skip` 与 `disable` 两个判定（修漏洞）；D6 统一备份命名 |
| 验收 | 全部编号改 `AD` 前缀并加 A/M 标记；AD1 弃用 `git diff`（`~/.dsh` 非 git 仓库）、AD6 弃用 `mcp({})`、AD11 补 `--dsh-home`、AD4 改用 `edits` 区间断言、AD7 明确须经组合造树；新增 AD14（往返）、AD15（并发）；AD13 对齐 `docs/development.md` |
| 不变量 | 新增 I8（公开导出面）、I9（配置往返）、I10（发布物边界）；I3 措辞明确「目标行允许新增 `disabled` 一行」 |
| 事实 | F3 降级为「仅记录」；F9 行号改 `:38-42`；F7 改 `:277`；F4 承接参数改 `src/proxy-tool.ts:131`；F2 引用改 `:210` + `:238-250`；F1 补「目标文件是 home 层」；新增 F13；补全六个取证包的版本；新增 §1.4 字段差异两条；§1.3 数字标注为估算 |
| 待验证 | V5 由源码验证后降级；V2 因 D3 改动作废；V1 保留为记录 |
