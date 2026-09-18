# 设计说明

> 给读代码的人：这个插件为什么长成这样，以及哪些约束不能动。
> 与代码不一致时以代码为准。文中数字都能用仓库里的脚本复现
> （`node scripts/measure-surface.mjs`、`node scripts/measure-token-savings.mjs`）。
> 与 `pi-mcp-adapter` 的逐项对照见 [parity-pi-mcp-adapter.md](parity-pi-mcp-adapter.md)。

## 1. 它要解决的问题

### 1.1 官方 MCP 插件的成本模型

`@deepseek-ai/dsh-mcp-client` 在 `apply` 阶段就 await 首次连接并拉全量 `tools/list`，把每个 MCP
工具注册成原生工具 `mcp__<server>__<tool>`。由此得到的成本结构是：

| 维度 | 现状 |
| --- | --- |
| 发现时机 | 加载即连接、即拉全量目录 |
| 工具面 | 每个 MCP 工具一个原生工具，描述与 input schema 进入**每一次请求** |
| 内存 | 一条目 = 一个常驻连接；stdio 条目再多一个常驻子进程 |
| 释放条件 | 只有 HMR / 重载，或重连预算耗尽（默认连续 10 次失败） |
| 懒加载 | 不存在：没有 lazy / defer / on-demand 的概念，`ToolDefinition` 也没有可见性开关 |

对「配了很多服务器、一整天只用到其中一两个」的用法，这笔账是倒过来的：没被调用的服务器也在
每次请求里付 schema 的钱。

### 1.2 省 token 靠的是「工具面恒定」，不是「动态增删」

模型侧的工具定义是请求的**前缀**。运行时增删工具会改动这段前缀，从第一个变化的 token 起
KV cache 失效——省下的 schema token 会以 cache 重算的形式还回去，甚至更贵。

所以本插件的默认形态是**恒定注册一个代理工具** `mcp`：工具名与参数 schema 由字面量定型
（`src/schema.ts`），与配了哪些服务器、连上了几台、发现了什么工具都无关。工具的真实 schema
按需经 `mcp({ describe })` 取，不进前缀。

### 1.3 生态里写 MCP 配置的一方只产出 `dsh-mcp-client` 行

配置面板、代码图一类的插件，以及按惯例办事的模型，都把新服务器写成
`name: '@deepseek-ai/dsh-mcp-client'` 的行。同一台服务器被两个插件同时注册时，工具不冲突、
不报错，但**省 token 的效果静默归零**——两边都注册，schema 照样进请求。这是 `adopt`
命令（§4）存在的原因，也是网关状态里那句冲突提示存在的原因。

## 2. 设计决策

### D1 — 模型可见面：恒定一个代理工具

- **默认**：只注册 `mcp`，参数表扁平（`search` / `describe` / `tool` / `args` / `server` /
  `regex` / `includeSchemas` / `limit` / `offset` / `instructions` / `connect`），一次定型、
  永不变化。
- **可选提升**：`directTools: true | string[] | "search"`（插件级默认 + 每服务器覆盖）。
  - `true` / `string[]`：把选中的工具注册成**真原生工具**（真 schema）。代价明确：工具面前缀
    会变。
  - `"search"`：工具以真 schema 但 **inactive** 状态注册，模型只能通过 `mcp({ search })` 触达，
    搜索命中即激活，之后可直接按名调用。激活只发生一次，且由模型自己的搜索触发。
- **缓存保护开关**：`freezeDirectTools` 在首次同步后冻结提升，后续元数据更新与重连不再重建
  系统提示。它约束的是**新增**，**不阻止撤销**：刷新后的目录不再提供的工具照样从原生面收回——
  留着一个服务器已经删掉的名字，只会让模型每次都调它并每次都报错，比名字消失更伤。

结论：默认路径（纯代理）字节恒定；只有显式配置 `directTools` 才承担前缀变化的风险，且有
`freezeDirectTools` 兜底。

### D2 — 配置来源：只用 DSH 原生 config

一个插件条目 = 一组服务器，字段命名与 `dsh-mcp-client` 对齐
（`serverName` / `transport` / `command` / `args` / `env` / `envFrom` / `cwd` / `url` /
`headers` / `toolCallTimeoutMs` …），现有配置可以直接搬过来。
**不**引入 `.mcp.json` 一类兼容层——多一个配置源就多一套语义要维护。

### D3 — 生命周期与回收

- `lifecycle`：`lazy`（默认）/ `eager` / `keep-alive` / `lazy-keep-alive`。
- `idleTimeout`：默认 10 分钟，`0` 表示禁用回收；显式值永远优先。
- 落地规则（`resolveServer`）：**只有 `lazy` 继承全局窗口**，其余三种一律解析为 `0`——
  它们的存在意义就是不被回收。`eager` / `keep-alive` 另外在插件激活时连接
  （`registry.residentServers()`），而默认的全 `lazy` 配置下这个列表为空，所以「加载期零进程」
  这条根基没有被破坏。
- 回收判据：连接活着 **且** 无在途调用 **且** 空闲超过窗口；30 秒扫一次，定时器 `unref()`，
  不阻止宿主退出。
- 重连：本插件**没有重连定时器，也没有退避阶梯**——失败后的重试就是 D7 的抑制窗口。掉线的服务器由下一次需要它的调用重新拉起并重新 spawn，启动失败的服务器要等抑制窗口过去。
- `reconnect` 字段被明确拒绝并给出替代做法，而不是接受后忽略。

### D4 — 磁盘元数据缓存

```
$DSH_HOME/storages/mcp-lazy/cache.json
{ "version": 1, "servers": { "<name>": {
    "configHash": "<sha256>", "cachedAt": 0, "ttlMs": null,
    "tools": [ … ], "instructions": "…" } } }
```

- 失效条件：`configHash` 变化、超龄（默认 7 天）、服务器发出 `tools/list_changed` 后重同步。
- 写入是**临时文件 + rename** 的原子替换；损坏的缓存按不存在处理，不抛错。
- **缓存里存的是未过滤的工具表**，`includeTools` / `excludeTools` 只在读取路径应用。
  反过来做过一次（存过滤后的集合、读取时再过滤一次）会留下一个真实缺陷：放宽过滤条件时，
  被排除的工具永远找不回来，最长僵到下一次超龄或一次真实连接——而懒加载下后者可能永不发生。
  因此 `computeConfigHash` 继续忽略这两个字段，但**这只在「缓存存全量」成立时才对**，
  两者必须同时为真，代码注释里写明了这一点。
- 声明了 `envFrom` 的条目，其哈希额外包含那些命令本身（不含命令的输出），所以换了取密钥的
  命令会重新 spawn；没有 `envFrom` 的条目保持原有摘要与缓存。

### D5 — 调用路径与错误面

- 动作分派优先级：`search` → `describe` → `instructions` → `connect` → `tool` → 状态。
  同时给 `search` 和 `tool` 时按搜索处理。
- 代理工具的 description 是**常量**：模型不调 `mcp({})` 就不知道有哪些服务器。这是为了前缀
  字节恒定的刻意取舍，代价写在 §6。
- 未知名 → 给出候选建议；歧义名 → 要求用 `server` 消歧；失败 → 明确诊断，**绝不伪造成功**。
- 超时：`toolCallTimeoutMs` 默认 60 s，透传调用方的取消信号。
- `search` 默认 `limit=12`，硬上限 40，超限裁剪而不报错。

### D6 — 输出体量治理

插件的账单单位是「几百 token 的工具定义」，而一次无上限的服务器返回能吃掉几万。框架层**不会**
替工具截断——`spill` 只存在于单个工具各自的实现里。所以本插件自带 `output-guard`：

- 超过 50 KiB 或 2000 行即保留头部，全文写入系统临时目录下的 `0o600` 文件，并在结果里给出
  路径与读取建议；落盘本身有 16 MiB 上限，防跑飞的服务器填满磁盘。
- 行切先于字节切（反过来会留下半行，让行数统计说谎），字节切不劈开 UTF-8 序列。
- 只对**服务器写的**载荷生效：工具返回、`describe` 的 schema、服务器的 instructions。
  网关自己生成的状态/搜索/错误文本按构造就是有界的，过一遍守卫只会凭空造出一个没人需要的
  落盘文件。
- 配置面 `outputGuard: true | false | { maxBytes, maxLines }`，默认开。无论如何配置都不会
  改变工具定义。

### D7 — 失败退避与诊断

- 失败后 60 秒内不自动重试（`FAILURE_BACKOFF_MS`），错误信息带上「多久前失败、还剩多久、
  原因」；**显式 `mcp({ connect })` 强制绕过退避**——刚修好配置的人不该被迫等窗口过去。
  成功即清除退避与错误记录。
- stdio 子进程的 stderr 改为 `pipe` 并保留有界尾巴（最后 3 行 / 8 K 字符），失败时折进错误
  信息。SDK 默认 `inherit` 时 `transport.stderr` 是 `null`，启动失败将拿不到任何子进程诊断。
- `debug: true` 恢复 `inherit`，把子进程日志还给终端。

### D8 — `envFrom`：密钥在 spawn 时取

`!!js` 在宿主加载配置时求值一次，所以之后轮换的凭据需要重启宿主，开机时还锁着的密码库会给
进程留下一个空字符串。「取密钥」这件事需要的时间点既晚于加载（能看到轮换）、又早于使用
（能大声失败），那就是 **spawn**。

- 条目声明 `变量名 → 命令`；每条命令经 `/bin/sh -c` 在每次 spawn 时跑一次，去掉首尾空白的
  stdout 成为子进程环境里的那个变量。**不做任何缓存**，所以轮换下一次调用即生效。
- `args` 里可以用 `{{NAME}}` 引用任何已声明的名字——这是给「只接受参数里带凭据的服务器」的
  唯一通路。宿主进程本身从不持有这个值。
- **失败绝不是空值**：非零退出、超时（默认 10 s，`envFromTimeoutMs`）、空输出、超过 64 KiB、
  含 NUL 字节，都会拒绝启动服务器并给出可读原因，而不是注入一个空白。`allowEmpty` 用来点名
  「空值确实正确」的变量。
- **值不去别的地方**：诊断只带变量名、退出码与命令自己的 stderr（封顶 2000 字符），从不带
  stdout；结果也不写回条目，因此进不了 `cache.json`。命令继承的是洗白后的环境
  （`scrubbedParentEnv`），不是该条目的 `env`，并跑在自己的进程组里——超时先 `SIGTERM`，
  一秒后 `SIGKILL`，升级保持武装直到组内成员全部消失。
- 加载期另有四条拒绝（`assertEnvFrom`）：名字同时出现在 `env` 与 `envFrom`、把 `envFrom`
  写在不会 spawn 的传输上、空命令、`allowEmpty` 点名了不存在的名字。

### D9 — 上游复用与漂移

连接与传输层尽量少改（那是踩过坑的代码），改动集中在「注册什么」。上游是 MIT，改自部分在
文件头保留原版权声明，`THIRD_PARTY_NOTICES.md` 注明来源。这样上游修 bug 时容易 rebase。

## 3. 接管命令 `adopt`

### 3.1 生态事实

写回用户的配置要求先弄清宿主怎么读它。以下都是可复现的实现事实：

| # | 事实 |
| --- | --- |
| 1 | patch 是**按 id 匹配的覆盖操作列表**，不是配置；四层依次应用，**找不到 id 只 warn 并跳过，退出码仍是 0** |
| 2 | patch 的 `config` 覆盖是**整体替换，没有深合并** |
| 3 | 因此「在别处追加一条同 id 的 `disabled: true`」会因层顺序而静默失效：目标行还没 insert，覆盖落空 |
| 4 | 同一 scope 内重复注册同名工具会**直接抛错**（`NamedNode` 风格的重名断言） |
| 5 | 官方插件的 `serverName` 与 http/stdio 字段与本插件同义，条目可以直接搬运 |
| 6 | 官方插件独有、本插件不支持的字段会被**拒绝并报错**，不是忽略 |
| 7 | 「现在到底配了什么」是四层组合的结果，一个只做「识别 + 追加」的行解析器算不出来 |
| 8 | `dsh --profile <p> --dump-config` **不启动宿主、不求值 `!!js`**，走的是同一个组合函数——它是离线且权威的真相源 |
| 9 | patch 解析失败会 fail loud，所以任何非原子写入都会被解析器看见并让宿主起不来 |

### 3.2 决策

| # | 决策 | 理由 |
| --- | --- | --- |
| 1 | 形态是**仓库内脚本**（`scripts/adopt.mjs`，也作为 `bin` 入口发布） | 配置手术离线做最安全；不需要宿主在跑；能进 CI 与文档 |
| 2 | **文本级改写** patch 文件，不调 loader 的写回 API | 要保留注释、空行与 `!!js` 表达式的原样字节，任何 dump→parse→dump 都会丢掉它们；loader 的写回会把四层组合结果展平进底文件，而 patch 层下次仍会再 insert 一遍 |
| 3 | 禁用方式是**就地**在被接管的那一行内部加 `disabled: true` | 不依赖层顺序（事实 1/3 的坑消失）；经配置面板整份重写后仍成立；追加同 id 的覆盖条目做不到 |
| 4 | 默认**干跑**，必须显式 `--write` 才落盘 | 改的是用户唯一的配置文件 |
| 5 | 写回前备份为 `<file>.bak-<yyyymmdd-hhmmss>-before-adopt`，按**实际被写的文件**逐项列出 | 回滚只能靠备份 |
| 6 | 幂等拆成两个独立判定：`skip`（不再新增 `servers` 条目）与 `disable`（只要原生行存在且其服务器已被接管，就要禁用该行） | 合成一条会把「已接管但仍存在原生行」这个最该禁用的情况一起跳过 |
| 7 | 读路径用 `dsh --dump-config`，写路径回到文本级只改一处 | 事实 7/8 |
| 8 | **不劫持 `@deepseek-ai/dsh-mcp-client` 的包名** | 代理工具名是单例 `mcp`，而同一 scope 重名注册直接抛错（事实 4）：N 个原生行 = N 个实例 = N 次注册同名工具 → 直接失败。要落地必须先做模块级单例 registry，属架构级改动 |
| 9 | 不处理 `--patch` 覆盖层，但检测到该层含原生行时必须在计划里报出 | 合法层，但 v1 不读写；不静默 |

### 3.3 接口

值一律以**原文片段**传递：`!!js` 在 loader 的方言里是表达式节点，解析后无法无损还原。
因此 `NativeRow` 同时带 `fields`（决定要用的字段）、`raw` 与 `span`（字节区间）、`keyIndent`
（行自身键缩进）与 `disabled` / `jsExpression` 标记。

```ts
export type AdoptSkipReason =
  | 'already-lazy'        // 已在 servers 中：不再新增条目（禁用仍要做）
  | 'missing-server-name'
  | 'unsupported-field'   // 本插件拒绝的字段（reconnect / failOnStartupError）
  | 'duplicate-native'    // 同一 serverName 出现多行
  | 'js-expression'       // 含 !!js，v1 不搬运
  | 'cannot-work'         // 搬过去本插件会直接抛错的条目（如 stdio 缺 command）
  | 'unresolved'          // 定位不到它声明挂载哪个插件：拒绝，计入退出码

export interface AdoptPlan {
  adopt: …
  disable: …
  skip: …
  blocked: number   // 「本该搬却没搬」的条数，只有它影响退出码
  edits: Array<{ file: string; start: number; end: number; replacement: string }>
}

export function planAdoption(composed, existingServers): AdoptPlan
```

CLI：

```
node scripts/adopt.mjs [--profile web] [--dsh-home <path>] [--file <path>]
                       [--write] [--json] [--allow-skip]
```

| 退出码 | 含义 |
| --- | --- |
| 0 | 无待处理项，或干跑成功，或 `--write` 成功 |
| 1 | 有「本该搬却没搬」的条目且未指定 `--allow-skip`。**注意此时写入已经发生** |
| 2 | 环境错误：文件不可读/不可写、结构无法识别、**写前 sha256 校验失败**（并发修改）。此时**零写入** |

`blocked` 与 `skips` 分开计数是必需的：第二次 `--write` 时那一行已经 `disabled`，会被算作
skip；若「skip 非空即失败」，第二次运行必然报错，幂等性就不成立了。

### 3.4 边界语义

| 情形 | 行为 |
| --- | --- |
| 行存在但缺 `serverName` | skip `missing-server-name`（官方插件里该字段 required，这类行本来也起不来） |
| 同一 `serverName` 多行 | skip `duplicate-native` |
| 同名服务器分布在 home 与 profile 两层 | 按 id 表语义只有一行的结果生效；计划标注实际生效的文件 |
| 含 `!!js` 的 server 条目 | skip `js-expression`（v1） |
| `cwd: ''` | 视同未设置，不搬运空串 |
| `transport: 'sse'` | 不会出现：官方插件只支持 stdio / streamable-http |
| `--patch` 覆盖层含原生行 | 在计划里报出，不读写 |

### 3.5 原子性与并发

配置面板是整份重写，本命令也是 → 后写的赢、先写的静默丢失。因此：

1. 写前记录每个目标文件的 sha256，**先校验完全部再写任何一份**；不一致则退出码 2，零写入。
2. 两阶段写入：先把所有备份与新内容写进同目录临时文件（可能失败的一步全在这里），再统一
   rename 换入；换入阶段出错则用备份回滚已换入的文件。
   「逐文件写、失败不回滚」是一种更糟的故障：第一个文件已改、第二个没改，那台服务器会
   **两个插件都不管**。
3. 文档建议在宿主停机时执行（profile 的 `patchReload: live` 会立即重组配置树）。

### 3.6 实现中才知道的事

- **行解析器不能自写全套。** js-yaml 不提供节点字节位置，所以「哪一行、哪个区间」只能自己按
  缩进扫；而「这一行的完整语义」手写扫描做不到（`!!js`、流式数组、块标量、锚点都要）。
  最终拆成三件事：语义用 `dsh --dump-config`（事实 8），解析用与宿主同一套方言的
  `JSON_SCHEMA.extend(JsExpr)`，字节区间用自写的缩进扫描（`splitSource` / `itemHeader` /
  `outermostItem` / `findRowEnd` / `findServersList`）。
- **缩进扫描器只需要处理它真会遇到的两件事**：`- id: X` / `- insert:` 形态的序列项，以及
  `servers:` 下的块式或空流式序列。遇到无法界定的形状（非空流式 `servers:`）就报错退出，不猜。
- **`findServersList` 返回的 `itemIndent` 是破折号所在的列**，不是键缩进。把破折号列当键缩进用，
  会产出把新服务器嵌进上一台服务器内部的非法 YAML。
- **`disabled` 只认行自身键缩进上的 `name:`**。行里若有块标量或 `env:` 含 `name:`，按「行内
  第一个像 `name:` 的行」去找会把 `disabled` 插进那个嵌套块，产出解析失败的 YAML——而且命令
  还会报「写好了」。
- **非目标行的「逐字节不变」有前提**：某个插件重写它自己的托管块时会把整块经 js-yaml 重新
  序列化，缩进与引号风格随之改变。本命令本身不动非目标行，但用户事后触发一次那个同步，
  该区块会整体重排——那是对方的行为，不是本命令的。
- **`--file` 模式**（只处理一个 patch 文件、不组合）让「零写入」可以由程序断言，而不只是读
  干跑输出。
- **`--json` 的 `wrote` 是标志位、不是结果**，所以同时给出 `writeRequested` 与 `filesWritten`；
  编辑区间的 `start` / `end` 是 JS 字符串下标（UTF-16 code unit），不是字节偏移——按字节消费
  这些数字会切错位置，而不变式仍然逐字节成立。

## 4. `/mcp-adopt`：在 GUI 里做同一件事

### 4.1 为什么有它

插件已经能看见原生行、也在状态里报警告（*"add it here, or disable the native row"*），但用户
要做的事是「开一个终端、跑一条 npx 命令」。这条命令把 CLI 已经做对的事搬进 GUI，由用户显式
触发一次。**它不是自动接管**：触发者仍然是人，写入仍然要显式 `apply`，默认仍然是干跑。
「插件启动时自动接管」这条边界没有被越过——被越过的只是「必须开终端」。

### 4.2 边界

- `commands.execute` 只由前端经 remote 调用，**没有工具把它包出来**，所以模型触发不了它。但要把话读完：把消息当命令派发的前端能到达它，而**这条命令在宿主进程内直接写文件，
  不经过工具的沙箱与审批链路**——在 `workspace-write` 策略下 bash 写不了 `~/.dsh/...`，
  这条命令写得进去。这是它的功能，不是可以忘掉的副作用。
- **插件代码变更需要重启宿主才生效**（`patchReload: live` 热重载的是位置解析，不是插件代码）。

### 4.3 决策

| # | 决策 | 理由 |
| --- | --- | --- |
| 1 | 命令**委托已发布的 `scripts/adopt.mjs`**，不重写组合逻辑 | 一条代码路径：备份、回滚、sha256 预检、原子写、退出码语义全部复用，两条路径不会漂移 |
| 2 | 用 `ctx.inject(['commands'], cb)`，**不改**插件的 `inject` | 把 `commands` 写进 `inject` 会让本插件在没有该服务的组合里永不激活——MCP 网关整体消失，是最坏的回退 |
| 3 | 默认干跑，`apply` 才写 | 与 CLI 一致 |
| 4 | 异步 spawn，不用 `spawnSync` | CLI 内部还要再起一个 `dsh --dump-config`，同步等待会阻塞宿主的 event loop 数秒 |
| 5 | profile 与 home 从 `ctx.baseUrl` 反推并**显式传给 CLI**；对不上 `<home>/profiles/<name>` 就报错，不退回默认值 | 宿主进程环境里没有 `DSH_HOME`；在别的 profile 里静默写 web 的配置属于「改不回来」那类错误 |
| 6 | 退出码 1（有跳过项）映射为 `success` + 一行警告，不是 `error` | 此时写入已经发生，把「部分成功」显示成红色错误会让人以为什么都没做 |
| 7 | 写入**不接受取消信号**，干跑接受 | 写入对两个文件连续 rename，中途被杀 = 「原生行已 disabled、服务器还没接管」 |
| 8 | 写入成功后**再跑一次干跑**并把结果贴出来 | 「写好了」与「写好了，而且重新规划是这么看的」是两件事；这是用户唯一能核对的证据 |
| 9 | 每次 CLI 调用有超时上限（默认 120 s），设在 handler 等待的那条缝上 | CLI 内部的子进程没有 timeout；`--dump-config` 卡住会让 GUI 一直转圈 |
| 10 | 计划显式报出**跨 profile 的影响面** | 见下 |

### 4.4 跨 profile 的影响面

原生行常常在 **home 层**（每个 profile 都读），而本插件的条目在某个 **profile 层**。禁用前者
等于把那个服务器从所有没挂本插件的 profile 手里一起拿走，而它们**只是失去能力，没有任何地方
会说**。计划本身看不见这件事——它从不看别的 profile。所以答案在渲染时算：遍历
`<dshHome>/profiles/*/package.json`，看谁的 bundles 里没有本插件，然后点名受影响的 profile
并给出两条出路（在那些 profile 里也挂本插件，或把行搬进当前 profile 自己的层）。

选**报警告**而不是**拒绝**：跨层形态正是这条命令最需要服务的场景，拒绝等于在最需要它的机器上
不可用。

### 4.5 不变量

| 编号 | 不变量 |
| --- | --- |
| J1 | 代理工具表面逐字节不变（`node scripts/measure-surface.mjs`） |
| J2 | 插件 `inject` 仍是 `['tools']`；不新增 inject 服务 |
| J3 | **每一条发布产物里的裸 import 都在 `dependencies` 或 `peerDependencies` 里**（静态扫描 `lib/` 与 `scripts/`） |
| J4 | 既有公开导出不减少 |
| J5 | 干跑与参数错误两条路径**零写入** |
| J6 | 命令注册随调用它的 fiber 自动卸载，不重复注册 |

### 4.6 已知不做

不做自动接管；不做 GUI 卡片按钮；命令不自己组合配置树、也不自己写文件（只调用 CLI 并翻译
退出码）；不支持 `--json` / `--file` / `--allow-skip` 等旗标；不改第三方插件的任何设置；
`src/command.ts` 是内部模块，不进 `exports`——接口里的注入点是给测试的，不是公开 API。

### 4.7 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 跨 profile 静默丢失能力 | 在 web 里 apply 一次，其它 profile 一起失去该服务器，无报错 | §4.4 点名受影响的 profile |
| 与配置面板抢写 | 后写的赢，先写的静默丢失 | 复用 CLI 的 sha256 预检 + 原子写；**只挡住「先写」方向**——对方事后按自己内存里的状态整份重写仍会吞掉改动，本命令无法察觉，用再次干跑复查 |
| 写入途中被取消 | 半个配置 | 写入阶段不接受取消 |
| 新配置让插件 `apply` 抛错 | 最坏情况命令与 `mcp` 工具一起消失 | 原子写只防「解析失败」，不防「语义失败」；因此 `src/adopt.ts` 直接 import 运行时的字段常量而不是复制一份，「CLI 接受的字段 == 运行时接受的字段」按构造成立 |
| 猜错 profile 写错文件 | 改到别的 profile 的配置 | 从 `baseUrl` 反推 + 显式传参 + 对不上就报错 |
| 宿主不是 Node | 入口推断依赖 `process.execPath` 的假设 | 只记录，不处理：DSH 支持的宿主就是 Node |

## 5. 全程不变量

改动这个仓库时，以下几项要么有测试、要么有可复现命令：

| 编号 | 不变量 | 核验 |
| --- | --- | --- |
| I1 | 模型可见工具面保持 **1525 字节 / 11 参数 / 381 token** | `node scripts/measure-surface.mjs` |
| I2 | 加载期零进程、零网络：`apply()` 不连接任何服务器。唯一的加载期 I/O 是**同步读一次元数据缓存**，好让 `search` 与 `describe` 立刻能答 | 测试（`plugin-load.test.ts`，用 PATH 陷阱断言只注册一个工具且不启动任何东西） |
| I3 | 非目标配置行逐字节不变（前提见 §3.6） | 测试：按 `edits` 区间做字节级比对 |
| I4 | 接管后的服务器仍可被调用，行为与接管前一致 | 测试（真实子进程 fixture） |
| I5 | `check` 的阶段顺序不变：`typecheck` → `lint` → `build` → `test:types` | `jq -r '.scripts.check' package.json` |
| I6 | `pretest` 仍是「构建 + 重链 peer 包」 | `jq -r '.scripts.pretest' package.json` |
| I7 | 运行时依赖只有 `@modelcontextprotocol/sdk` 与 `js-yaml` | `jq '.dependencies' package.json` |
| I8 | 已发布的公开导出不减少 | 人工核对：对比 `lib/index.d.ts` 的导出清单。仓库内没有跟踪这份清单的测试，只有少数导出键的存在性断言 |
| I9 | 配置语义可往返：接管后的文件经配置面板整份写回一次，`disabled` 仍成立、`servers` 与全局设置不丢 | 机制：就地改写保持同 id，而配置面板按 id 建表、同 id 只保留第一条；测试覆盖「行级 `disabled` 能被读回」与「第二次运行零写入」。**整份重写的端到端场景没有自动化用例**，见 §4.7 的风险表 |
| I10 | 发布物边界清楚：`files` 里的每一项都是有意发布的 | `npm pack --dry-run` |

## 6. 成本与取舍

代理工具表面（`node scripts/measure-surface.mjs`）：

```
工具名 mcp，参数 11 个，wire 1525 字节 ≈ 381 token
```

真实服务器（`chrome-devtools-mcp@1.6.0`，29 个工具）：

```
原生注册  21252 字节 ≈ 5313 token
本插件     1525 字节 ≈  381 token
省下       92.8%
```

反向的账也要说清：本插件**没有**自动预热（新增服务器后，搜索只会说「还没有缓存」，模型要先
想到 `connect`）；代理工具的描述是常量，不含服务器名单；`search` 有 40 条上限，模型无法一次
列全上百个工具。这些是换取恒定前缀的代价，不是疏漏。

## 7. v1 的边界

OAuth / bearer 存储、UI apps、resources-as-tools、prompts、sampling / elicitation、共享进程
（rmcp-mux）、每请求 header 命令、别的宿主的配置导入、脚本模式、工具审批门——都不做。
理由只有一个：fork 出一个维护不起的巨大上游没有意义。缺口的体量在
[parity-pi-mcp-adapter.md](parity-pi-mcp-adapter.md) 里量过，边界与 README 的 Known Limitations
一致。

## 8. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 动态工具注册 vs KV cache | 省 token 反被 cache 击穿 | 默认恒定单工具（I1）；`directTools` 显式可选 + `freezeDirectTools` 约束增长（撤销仍会改变工具面） |
| fork 上游漂移 | 官方修的 bug 拿不到 | 只改「注册什么」，连接/传输层尽量与上游 1:1（D9） |
| 缓存陈旧导致模型按旧 schema 调用 | 调用失败 | `configHash` + 年龄上限；已知工具名校验；失败信息给出刷新动作 |
| 代理工具 schema 过大 | 恒定成本上升 | 参数保持扁平，目标 ≤ 400 token |
| 空闲回收误杀长任务 | 进度丢失 | 在途计数；回收前 quiesce |
| 与官方插件并存时的命名 | 工具名冲突 | 各自 `serverName` 命名空间；重复即报错 |
| `"search"` 模式激活导致前缀变化 | 命中那一刻 cache 失效 | 激活只发生一次且由模型搜索触发；文档写明；`freezeDirectTools` 冻结新增（撤销不受影响） |
| 改写用户唯一的配置文件 | 配置损坏后 MCP 全挂 | 默认干跑、写前备份、sha256 预检、两阶段写入 + 回滚（§3.5） |
| `envFrom` 命令自己泄漏密钥 | 值出现在错误信息或日志里 | 诊断只带 stderr、从不带 stdout；值不落盘、不写回条目 |
