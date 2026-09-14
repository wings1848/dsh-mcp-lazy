# dsh-mcp-lazy — 接管命令（adopt）方案与验收标准

**状态**：**已实施**（M0–M6 全部完成）。§8 的三条待验证已补齐（见 §8.1–§8.3）；实现与本文的差异见 §11。
**本仓库版本**：方案写于 `0.1.1`；实施后随本文件一起以 `0.2.0` 发布。
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

### D8 — 明确不做的迁移对象（**实施后修正**）

原决策：`@hyzyn/dsh-codegraph` 的托管行会被插件自身重写（F2），接管它需要同时把该插件的
`mcpIntegration` 设为 `false`，属跨插件协同动作，不进 v1。

**实施后修正为：不改该插件的设置，但它的托管行照常接管。** 理由与实测见 §8.1 与 §12.2——
「需要同时关掉联动」这个前提经实测不成立（该插件重写托管块时保留 `disabled`），而不接管恰恰会把
本机唯一实际存在的 native 行留在原地，省 token 依旧归零。

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
- 不处理 `@hyzyn/dsh-codegraph` 的**设置**（D8）；但它写下的 `dsh-mcp-client` 托管行会被接管。

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
4. **不处理 `@hyzyn/dsh-codegraph` 的设置**（D8）：不改它的 `mcpIntegration`，不参与跨插件协同。但它
   写下的 `dsh-mcp-client` 托管行会被**像其它 native 行一样接管**——D8 原先「不迁移」的理由经实测不
   成立，见 §8.1、§12.2。
5. **不处理 `--patch` 覆盖层**：它是合法层（`dsh --help:15-16`），但 v1 只在计划里报出，不读写。
6. **不为 `dsh-mcp-client` 添加本插件不支持字段的实现**（`reconnect`、`failOnStartupError`）。

---

## 8. 实施前必须补的验证

| 编号 | 待验证 | 验证方式 |
| --- | --- | --- |
| V1 | `Entry.update()` 究竟会把什么写进哪个文件（D2(b) 的危险已由源码推断，但未实测） | 在隔离 profile 上调用并 `git diff` 前后比对。**注意：D2 已定案不采用 (b)**，此项仅为记录风险，不阻塞实施 |
| V2 | ~~`disabled` 覆盖是否按数组顺序匹配~~ | **因 D3 改为就地改写而作废**：不再依赖层顺序。F11 的层序知识仍需保留（解释为何不能追加覆盖） |
| V3 | 被禁用的 `dsh-codegraph-managed` 行是否会被该插件重写回来 | **已补，结果见 §8.1** |
| V4 | `dsh --profile web --dump-config` 对 `disabled` 条目的呈现形式（AD2、AD10 依赖它） | **已补，结果见 §8.2** |
| V5 | ~~「同层重名工具注册会失败」~~ | **已由源码验证**（F13，`dsh-tools/lib/index.js:2538`），无需实测；实测可选 |
| V6 | 行解析器的最小充分文法；解析器需同时识别 `dsh-mcp-client` 行与本插件的 `servers` 数组 | 对两个真实 patch 文件跑解析并断言 round-trip 一致。**本机现状实测**：home 层 34 行、0 处 `!!js`、4 处块式数组；profile 层 98 行、**5 处 `!!js`**、1 处流式数组 `[...]`、16 处块式数组；缩进层级覆盖 0/2/4/6/8/10 |

### 8.0 隔离沙箱（V3/V4 与 AD10 的公共前提）

`dsh --profile web --dump-config` 会往 profile 目录写 `cordis.yml`，所以**对真实 `~/.dsh` 跑不了**
（实测：`EROFS: read-only file system, open '/home/wings/.dsh/profiles/web/cordis.yml'`——本机不是只读
盘，是运行沙箱拦下的写入；无论哪种原因，结论相同：需要一个副本）。

副本由 `.tmp/bootstrap-sandbox.sh` 生成（`.tmp/` 已在 `.gitignore` 内）：

```bash
.tmp/bootstrap-sandbox.sh            # -> .tmp/iso
DSH_HOME=$PWD/.tmp/iso dsh --profile web --dump-config
```

它复制 web profile 的 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `cordis.patch.yml`
与 home 层 patch，并**摘掉两个 bundle**，理由各一：

1. `@xmanrui/dsh-im` 是 `file:` 依赖，指向同级 checkout，副本装不上，且与本命令无关；
2. `dsh-config-manager` **会在启动时按自己的状态整份重写 profile patch 层**。实测：带上它跑一次
   `--dump-config`，复制进去的 105 行 `cordis.patch.yml` 变回一个光秃秃的 `[]`。**沙箱的 patch 层被
   测试对象改写，就不成其为沙箱**——这一条同时也印证了 §6 表格里「config-manager 整份重写」那行风险。

### 8.1 V3 — 被禁用的托管行会被 codegraph 重写回来吗

**结论：不会。** 两条路径都实测过，`disabled: true` 都保留。

取证对象：`~/.dsh/profiles/web/node_modules/@hyzyn/dsh-codegraph/lib/index.js`，导出纯函数
`syncManagedMcpRow(lines, decision)`（`:114-232`）。

```bash
# 在沙箱 home 层的托管行里就地插入 disabled: true，然后跑该插件的同步纯函数
node --input-type=module -e '
const mod = await import("/home/wings/.dsh/profiles/web/node_modules/@hyzyn/dsh-codegraph/lib/index.js")
const lines = ["", "# --- dsh-codegraph mcp managed (auto-generated; do not edit) ---", "- insert:", "    - id: mcp-codegraph-managed", "      name: \x27@deepseek-ai/dsh-mcp-client\x27", "      disabled: true", "      config:", "        serverName: codegraph", "        transport: stdio", "        command: codegraph", "        args:", "          - serve", "          - \x27--mcp\x27", "        cwd: /home/wings", "# --- end dsh-codegraph mcp managed ---", ""]
for (const d of [{ targetCwd: "/home/wings", manageEnabled: true }, { targetCwd: "/tmp/elsewhere", manageEnabled: true }]) {
  const o = mod.syncManagedMcpRow(lines, d)
  console.log(JSON.stringify(d), "changed:", o.changed, "disabled 保留:", o.lines.join("\n").includes("disabled: true"))
}'
```

实测输出：

```
{"targetCwd":"/home/wings","manageEnabled":true} -> changed: false | disabled survives: true
{"targetCwd":"/tmp/elsewhere","manageEnabled":true} -> 走重写路径：changed: true | disabled survives: true | cwd 被对齐回 /home/wings
```

机制：该插件的 `own` 块路径（`:185-200`）复用解析出的行对象，只对齐 `config.cwd`，其余字段原样
`yaml.dump` 回去；`disabled` 是行级字段，落在往返里。**唯一的例外是 `mcpIntegration: false`**
（`:166-180`）：那条路径会**整行删除**托管行——这是该插件自己的设置，本命令不去动它（D8），且删除对
省 token 而言是更强的结果，不是风险。

**同时修正一处设计文档未写的事实**：该插件重写区块时会把整块经 js-yaml 重新序列化，因此
`args` 列表的缩进与引号风格会变（实测 `- serve` / `- '--mcp'` 缩进从 10 空格变成 8）。也就是说
**I3「非目标行逐字节不变」只在「不触发 codegraph 重写」的前提下成立**。接管命令本身不改非目标行，
但用户事后触发一次 codegraph 同步，那个区块会整体重排——这是该插件的行为，不是本命令的。

### 8.2 V4 — `--dump-config` 怎么呈现 `disabled`

**结论：原样打印 `disabled: true`，且不报任何警告。**

探针 profile（`.tmp/iso/profiles/webtest/cordis.patch.yml`）同时放一条禁用行和一条启用行：

```bash
DSH_HOME=$PWD/.tmp/iso dsh --profile webtest --dump-config
```

组合结果片段（`:541-553`）：

```yaml
- id: probe-native
  name: '@deepseek-ai/dsh-mcp-client'
  disabled: true
  config:
    serverName: probe-disabled
    ...
- id: probe-native-live
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: probe-live
```

两行都在、`disabled` 保留，可据此判定 AD2/AD10 的「该条目的 `disabled` 为真」。

**顺带实测到 F11 的静默失效指纹**（这是 AD2 要断言 stderr 干净的原因）：在该 profile 的 patch 层
追加一条针对 **home 层** id 的 `disabled: true` 覆盖：

```bash
dsh: [.../webtest/cordis.patch.yml] patch: entry "mcp-codegraph-managed" not found
```

**退出码仍是 0**，而 home 层那一行照旧启用。这正是 D3 改成「就地改写」要绕开的坑。

### 8.3 V6 — 解析器的充分性

**结论：原计划「自写行解析器」被证伪，改为 js-yaml + 行级定位的混合方案。**

原计划要自写一个行解析器同时读 `dsh-mcp-client` 行与本插件的 `servers` 数组，并断言 round-trip 一致。
实测下来这条不成立，原因是 **js-yaml 不提供节点字节位置**：要"哪一行、哪个区间"，只能自己按缩进扫；
但要"这一行的完整语义"，手写扫描做不到（`!!js`、流式数组、块标量、锚点都要）。最终方案拆成两半：

| 关注点 | 用什么 | 为什么 |
| --- | --- | --- |
| 现在到底配了什么 | `dsh --profile <p> --dump-config`（§3.1） | 四层 patch 语义只有 `applyEntryPatches` 算得出 |
| 语义解析 | js-yaml + `JSON_SCHEMA.extend(JsExpr)`（与 `dsh-app-boot` 同一套方言） | 与宿主逐字同构 |
| 字节区间 | 自写缩进扫描（`splitSource` / `itemHeader` / `outermostItem` / `findRowEnd` / `findServersList`） | js-yaml 不记位置 |
| 写回 | 只替换算出来的字节区间，其余字节原样 | 保住注释、空行与 `!!js` |

语法覆盖面的实测样本（两个真实文件，见 §8.0 沙箱）：

| 层 | 行数 | `!!js` | 流式数组 | 块式数组 | 缩进层级 |
| --- | --- | --- | --- | --- | --- |
| home `~/.dsh/cordis.patch.yml` | 34 | 0 | 0 | 4 | 0/2/4/6/8 |
| profile `profiles/web/cordis.patch.yml` | 105 | 5 | 1（`args: !!js "[...]"`） | 16 | 0/2/4/6/8/10 |

扫描器只被要求处理**它真的会遇到的两件事**：`- id: X` / `- insert:` 形态的序列项，和
`servers:` 下的块式/空流式序列。遇到无法界定的形状（非空流式 `servers:`）就报错退出，不猜。

> **本节派生出一条设计文档没写、但实现必须有的东西**：`findServersList` 返回的
> `itemIndent` 是**破折号**所在列，而 `renderServerEntry` 需要知道破折号列才能把键放到它右边两列——
> 第一版把 `itemIndent` 当成键缩进用，实测直接产出把新服务器嵌进上一台服务器内部的非法 YAML
> （AD2 立刻以 `bad indentation of a mapping entry` 失败）。这条已在 `renderServerEntry` 的
> 文档注释里写死。

---

## 9. 里程碑

| 阶段 | 内容 | 出口判据 | 结果 |
| --- | --- | --- | --- |
| M0 | 补 §8 的 V3、V4、V6（V1 不阻塞、V2 作废、V5 已验） | 三条各有一条可复现命令与实测输出归档到本文件 | ✅ §8.1 / §8.2 / §8.3 |
| M1 | 修 F4（检测现算）+ 回归测试；处理 D4 的公开 API 影响 | AD6、AD8、AD12 | ✅ 惰性 getter + 4 条新用例；`lib/index.d.ts` 导出清单不变，第 4 参类型放宽 |
| M2 | `src/adopt.ts` 纯函数 + 单测 | 单测覆盖 adopt / disable / skip 三类分支，每条留验红记录 | ✅ 三个模块（`adopt.ts` / `adopt-patch.ts` / `adopt-compose.ts`）+ 50 条用例 |
| M3 | `scripts/adopt.mjs` dry-run（含 `--json`、`--dsh-home`） | AD1、AD4、AD5、AD11 | ✅ |
| M4 | `--write` + 备份 + 并发校验 | AD2、AD3、AD9、AD14、AD15 | ✅ |
| M5 | 宿主集成验证 | AD7、AD10、AD13 | ✅ AD7 落在 `connection.e2e.test.ts`；AD10 在隔离 profile 上跑通 |
| M6 | 文档与发布 | README/README-zh 增补命令说明；`docs/configuration.md` 增补接管的取舍；`package.json` 的 `files` 决定是否发布 `scripts/adopt.mjs`（I10）；CHANGELOG 记录 | ✅ 见 §11 |

### 验红记录（AD12）

测试跑的是**构建产物**（`import '../../lib/…'`），所以「改 `src/` 不构建」不会让任何用例变红——
这一点在 M1 上实测过：把 `src/index.ts` 改回快照版本、不重新 `build`，3 条新用例照旧全绿，只有改
`lib/index.js` 才红。因此每一次验红都是**改构建/发布产物**（`lib/` 或 `scripts/`），用
`.tmp/red-proof.mjs`（一条命令跑完全部用例，改完自动还原，清单在 `.tmp/cases.json`）：

```bash
node .tmp/red-proof.mjs     # 9/9 cases went red with the fix reverted
```

| 被撤销的修复 | 变红的用例 | 观察到的断言 |
| --- | --- | --- |
| 序列项结束位置取首行而非末行 | `finds the end of the last item, not the end of its first line` | 追加点落进上一台服务器内部 |
| 行的区间用「外层 `- insert:` 整块」 | `finds the second row of a block that holds two` | 查第二行时用第一行的 id 抛错 |
| `insertDisabled` 取行内第一个像 `name:` 的行 | `is not fooled by a nested name: inside the row` | `disabled` 落进嵌套块 → 后续 YAML 解析失败 |
| 已 `disabled` 的行改成「可行动的 skip」 | `is idempotent: a second run writes nothing and takes no new backup` | 第二次退出码 1、且新增备份 |
| 写入逐文件进行、失败不回滚 | `leaves every file alone when the second one cannot be written` | 第一个文件已改、第二个没改 |
| F4：检测在 `apply` 时快照 | `stops reporting a server the loader no longer declares` | 状态里仍在报 `dsh-mcp-client` |
| 惰性 getter 只在渲染时取一次 | `re-reads the loader on every render, not once per process` | 三次渲染给出同一份名单 |
| 只认条目级 `disabled`，不认行级 | `ignores entries the other plugin has disabled` | 被禁用的行仍被列为冲突 |
| 入口判定不解析软链（`bin` 入口静默失效） | `runs when invoked through a symlink, the way a `bin` entry is` | 退出码 0 但**什么都不打印**——看起来像「无事可做」，而不是像安装坏了 |
| I1 的字节数断言是否真的敏感 | `registers the exact surface the I1 invariant pins` | `1525 !== 1526` |

**两条没能验红、已如实说明**：

- `findServersList` 里「只认同级 `- `」的缩进过滤。原以为它是防「追加点落进嵌套 `args`」的关键，
  实测撤销它仍然全绿——因为结束位置由 `findRowEnd` 从找到的那一项算起，嵌套项也算出同一个追加点。
  它现在被注释标记为**防御性**而非承重。
- B3 / B5 / B6 三条（见 §12.1）的回归测试在位，但它们的「撤销」不落在任何**单行**注入上：B3 是整段
  解析策略换了，B5 / B6 是分支内的取值。按「没留痕的测试视为未验红」的标准，这三条只在**测试覆盖**
  意义上成立。

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

---

## 11. 实施结果（本轮）

M0–M6 全部落地。下面是**实现与本文的差异**，以及交付时才知道的事。

### 11.1 与本文不同的地方

| # | 本文写的 | 实际做的 | 为什么 |
| --- | --- | --- | --- |
| 1 | `NativeRow` 只有 `{ id, serverName?, raw, layer, file }` | 还有 `fields`（`config` 的字段 + 行自身的 `id` / `name` / `disabled`）、`span`、`keyIndent`、`disabled`、`jsExpression` | 文本级改写需要**字节区间**，而 Plan 需要在决定前读字段。本文只说"raw 逐字节保留"，没说区间从哪来 |
| 2 | 一个 `src/adopt.ts` | 拆成 `adopt.ts`（决策）/ `adopt-patch.ts`（字节手术）/ `adopt-compose.ts`（读组合结果） | 三个关注点的失败模式完全不同，混在一起测不出边界 |
| 3 | `AdoptSkipReason` 五种 | 六种，多一个 `cannot-work` | 计划阶段就拦下**本插件加载会直接抛错**的条目（stdio 无 command 等）。不改的话，接管会把一个能跑的配置换成加载失败的配置 |
| 4 | `skip` 非空即退出码 1 | 新增 `plan.blocked` 计数，只有"本该搬却没搬"才影响退出码 | 否则**第二次 `--write` 必然失败**（那一行已经 `disabled`，会被算作 skip），AD3 的"第二次退出码 0"自相矛盾。这是设计文档里的一个真实漏洞 |
| 5 | 无 | `--file` 模式（只处理一个 patch 文件，不组合） | §3.4 列了这个参数但没说它做什么。它的存在让"零写入"能被**程序级**断言（test/unit/adopt-run.test.ts），而不只靠读干跑输出 |
| 6 | 未提 | 检测 `dsh-config-manager` 之外的第二个沙箱陷阱：它启动时整份重写 profile layer | 见 §8.0 第 2 条 |
| 7 | `skip` 原因 `already-lazy` 一处语义 | 两种语义各有一条 `detail` | 一个是"行已禁用"，一个是"服务器已在 servers 里但行还要禁用"。D7 把判定拆开了，原因名却共用一个，靠 `detail` 区分 |

### 11.2 交付时才知道的事实（补进 §1 序列）

| 编号 | 事实 | 取证 |
| --- | --- | --- |
| F14 | `dsh --dump-config` 的层标签是 `base, patched by <layer>` 形式，**文件路径在 `patched by` 之后**，不是标签本身 | `.tmp/iso/dump-web.json`：`# == dsh-mcp-lazy, patched by …/profiles/web/cordis.patch.yml`。据此才有 `fileOfMarker` |
| F15 | `@hyzyn/dsh-codegraph` 重写托管区块时**整块经 js-yaml 重新序列化**，缩进与引号风格会变 | §8.1 末段。推论：I3 的"逐字节不变"只在"不触发该插件重写"的前提下成立 |
| F16 | 本机 `~/.dsh` 是**运行沙箱拦下的写**（`EROFS`），不是磁盘只读 | 直接对真实 home 跑 `dsh --profile web --dump-config` 的报错。存档：验证必须走隔离副本（§8.0） |

### 11.3 验收实测摘要

| 编号 | 判定 | 证据 |
| --- | --- | --- |
| AD1（A） | ✅ | 干跑前后 sha256 与 mtime 完全相同，0 个备份文件 |
| AD2（A） | ✅ | 组合结果里该条目 `disabled: true`，`dsh` stderr **为空**（F11 指纹不出现） |
| AD3（A） | ✅ | 第二次退出码 0、`Wrote 0 file(s)`、字节不变、备份数不变 |
| AD4（A） | ✅ | `--json` 的 `edits` 区间与原文逐字节一致；去掉新增行后与原文件全等（home 1057→1078 B，差 21 B = 一行） |
| AD5（A） | ✅ | `reconnect` 行进 `skip: unsupported-field`，且**不产生任何 disable** |
| AD6（A） | ✅ | 3 条新用例；验红见 §9 |
| AD7（A） | ✅ | `connection.e2e.test.ts`：真子进程 fixture，被禁用的条目启动计数 **0**，对照组 1 |
| AD8（A） | ✅ | `measure-surface.mjs` 1525 B / 11 参 / 381 token；`apply()` 路径断言同值（验红：注入 1 字节 → 1526 ≠ 1525） |
| AD9（A） | ✅ | 两份备份存在且命名合规；用备份覆盖后 sha256 与接管前**完全相同** |
| AD10（M） | ✅ | 隔离 profile：`codegraph` 出现在本插件 `servers` 下，原条目 `disabled: true`——注意这正是 §12.2 里「按实现修正文档」的那一条：codegraph 的托管行**是**接管对象 |
| AD11（A） | ✅（换判据） | 只读副本在本机造不出（fuseblk 上 `chmod` 不生效，见 §12.3），改用三条确定性等价断言：目标文件不存在 / 组合失败 / **注入写入失败后回滚**，都退出码 2 且零损失 |
| AD12（A） | ✅ | §9 的 9 项验红（`lib/` 与 `scripts/` 的**构建/发布产物**），另加 §12.1 里由独立核验发现的 6 条缺陷修复 |
| AD13（A） | ✅ | 干净环境复现见 §11.4 |
| AD14（A） | ✅ | 模拟整份重写后：`disabled` 仍真、7 台服务器一台不丢、`idleTimeout`/`outputGuard` 未丢 |
| AD15（M） | ⚠️ 部分 | 保护机制在（写前逐文件校验 sha256，且**先校验完全部再写任何一份**），`--json` 真的报出两份文件的 digest 供比对，回归测试断言该 digest 的**正确性**（即保护的前置条件）；但「运行中途文件被改」这条时序**无法做成端到端断言**——单进程内不能在计划与写入之间插入外部改动，本机是 root 且 fuseblk 上 `chmod` 不生效（实测 `chmod a-w` 后仍能写）。**作为补偿**，写入改成两阶段 + 失败回滚，并把它做成了可注入的回归测试（§12.1 B4）：那一条比 AD15 更强，因为它断言的是「写到一半也不丢数据」 |

### 11.4 干净环境复现（AD13）

```bash
rm -rf lib node_modules .tmp/iso
pnpm install --frozen-lockfile
pnpm run check          # typecheck → build → test:types
pnpm test               # 271 tests, 65 suites, all pass
```

### 11.5 发布物边界（I10）

`scripts/adopt.mjs` **是发布物**，并且新增了 `bin` 入口，理由：

- 它对使用者有用（`npx dsh-mcp-lazy-adopt` 比 `node node_modules/.../scripts/adopt.mjs` 好记得多）；
- 它不改变运行时依赖数：`js-yaml` 与 `@types/js-yaml` 进的是 `devDependencies`，`scripts/` 不在运行时
  路径上（`src/index.ts` 不 import 它），I7 的"运行时依赖 1 个"因此仍成立；
- `exports` 新增 `./adopt` 指向 `lib/adopt.js`，让纯函数可被别的工具复用。

---

## 12. 交付前的独立核验（对抗式复核）与缺陷修复

M0–M6 完成后做了一次**独立子代理核验**：它拿到的是本文与仓库，任务是「找反例，不要信声明」。
它复现了 AD1 / AD3 / AD4 / AD5 / I3 / I7 / I8（其中 AD4 用它自己写的验证器，不 import 仓库代码；
I8 用 `tsc --strict` 编四种调用形态验证「第 4 参放宽」不是破坏性变更），也**报了 6 条真实缺陷**。

这一段是关键留痕：**「我自己测了并通过」和「别人来找反例也没找到」是两件不同的事。**

### 12.1 已修（每条都补了回归测试 + 验红）

| # | 缺陷 | 症状 | 修法 |
| --- | --- | --- | --- |
| B1 | `insertDisabled` 取行内**第一个**像 `name:` 的行 | 行里若有块标量 / `env:` 含 `name:`，`disabled: true` 被插进那个嵌套块 → **YAML 解析失败**，而命令 exit 0 报「Wrote N file(s)」。实测后续 `dsh --dump-config` **exit 1**：宿主机直接起不来，且该行并没有被禁用 | 只认**行自身键缩进**（`keyIndent`）上的 `name:` |
| B2 | 行的字节区间是**外层 `- insert:` 整块** | 一个 insert 块里两条行 → 查第二条时用第一条的 `id` 抛错，整份命令 exit 2，**一台服务器也接管不了**；即使只查第一条，编辑区间也把兄弟行圈进去 | 按「`- insert:` 列表里那**一个** item」定位；`parseRow` 接受光标本身即行的形态 |
| B3 | 行的 `name:` 在**哪个文件**是猜的 | 只存在 `- id:` + `config:` 的**补丁行**（合法形态）会被 `parseRow` 拒 → 行被静默丢弃 → `--json` 给出 `{files:[],blocked:0,skips:[]}`、exit 0、「Nothing to do」，**双跑照旧** | 改为询问**每个可编辑文件**；「自己声明挂载哪个插件」的那份优先；实在定位不到就按 `unresolved` **拒绝并计入退出码**（不再有静默丢弃这条路径） |
| B4 | 写入是**逐文件**的，失败**不回滚** | 第二个文件写失败时第一个已经落盘 → 该服务器**两个插件都不管了**（既没进 servers，原行又被禁用） | 两阶段：先把所有备份 + 所有新内容写进同目录临时文件（可失败的一步全在这里），再统一 rename 换入；换入阶段出错则用备份回滚已换入的文件 |
| B5 | `servers:` **行尾注释**被判为非法值 | `servers:   # add servers below`（块式列表+注释）→ exit 2，**整个文件里所有服务器都接管不了** | 行尾 `#` 之后不算值；值以 `#` 开头则视为空 |
| B6 | `insertDisabled` / `renderServerEntry` 硬编码 `\n` | CRLF 文件被写成**混合行尾**（3 行 LF-only）；每次追加还**多一个空行** | 行尾由文件决定并一路传下去；追加时的换行取「插入点之后那个换行序列」，没有才自己补 |

另外修了三条核验点出的**表述/体验**问题：

- `PlannedEdit.start/end` 的注释写「byte offset」，实际是 **JS 字符串下标（UTF-16 code unit）**。AD4 的字节级结论仍然成立（区间按字符切、区间外原样搬运），但按字节消费这些数字会切错位置——注释已改成「字符下标」，并说明为什么区间仍然逐字节保真。
- `--file` 模式的头部原先打印的是**真实 `~/.dsh` 的两个路径**，看着像要改真实配置；现在打印它真正处理的那一个文件。
- `--json` 的 `wrote` 在「传了 `--write` 但无事可做」时也是 `true`，名字像结果、实际是标志位。现在同时给出 `writeRequested` 与 `filesWritten`。

### 12.2 核验同样确认了「实现与文档的一处真实矛盾」（已按实现改文档）

本文 §7.4 / D8 写着**不迁移 `@hyzyn/dsh-codegraph` 的托管行**，但实现里没有任何 id 或来源排除，
隔离沙箱里它**确实接管了** `mcp-codegraph-managed`（§11.3 的 AD10 还把它记成 ✅）。

**结论是改文档、不是改代码**，理由有三条，且都有实测支撑：

1. **D8 原文的理由已经不成立**：它说接管 codegraph 的托管行需要同时把该插件的 `mcpIntegration`
   设为 `false`，属跨插件协同。实测（§8.1）**不需要**——该插件重写托管块时保留 `disabled`，
   所以就地禁用一次即可，它不会把行改回来。
2. **不接管才是真问题**：这正是本命令存在的理由（生态各方都写 `dsh-mcp-client` 行）。把 codegraph
   排除在外等于对最常见的来源之一视而不见，而它恰恰是本机唯一实际存在的 native 行。
3. 「不处理跨插件协同」的边界仍然成立：命令不改 codegraph 的任何设置，只改它写下的那一行。

因此 §7.4 的措辞改为「不处理 `@hyzyn/dsh-codegraph` 的**设置**（`mcpIntegration`），但会像对待任何
其它 native 行一样接管它的托管行」。**这是本设计文档唯一一处按实现修正的地方。**

### 12.3 未能验红、已如实降级的条目

- **AD11 的字面场景**（`--dsh-home <只读副本> --write` → exit 2 且副本未改）在本机**造不出来**：
  文件系统是 fuseblk，**`chmod` 不生效**（实测 `chmod 444` 后仍可写、`chmod 555` 目录后仍能建文件），
  且进程是 root。现已改为三条等价的确定性断言：目标文件不存在 / 组合失败 / **注入写入失败**（12.1 B4）。
  最后一条比 AD11 要求的更强：它不仅要求「零写入」，还验证了「写到一半之后的回滚」。
- **AD15 的时序**（计划与写入之间被外部改动）单进程内无法注入；现断言该保护的前置条件——
  `--json` 报出的 digest 与文件实际 digest 一致，并在 §11.3 标注为「部分」。
- **`findServersList` 的「只认同级 `- `」过滤**：撤销它测试仍然全绿（结束位置由 `findRowEnd` 决定），
  已在代码注释里标为**防御性**而非承重。

### 12.4 修完之后的复核

```bash
node .tmp/red-proof.mjs     # 9/9 cases went red with the fix reverted（用例清单在 .tmp/cases.json）
```

九条验红覆盖：B1、B2、B4、幂等性（`blocked` 语义）、F4 惰性检测、惰性 getter、行级 `disabled`、
`bin` 软链入口、I1 字节数断言。B3 / B5 / B6 的回归测试在位，但它们的「撤销」不落在任何**单行**注入上
（B3 是结构性的：整段解析策略换了；B5 / B6 是分支内的取值），故未列入本清单——按「没留痕的测试视为
未验红」的标准，这三条只在**测试覆盖**意义上成立，在此如实说明。
