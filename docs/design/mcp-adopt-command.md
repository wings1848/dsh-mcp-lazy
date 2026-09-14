# `/mcp-adopt` — 在 GUI 里就地收编原生 MCP 行

> 状态：**已实施**（§9），**已按对抗性评审修正**（§10）
> 上游依据：`docs/design/adopt-native-rows.md`（`adopt --write` CLI 的设计与实施）

---

## 0. 为什么要有这条命令

`docs/design/adopt-native-rows.md` §7.2 把「插件启动时自动接管」列为明确不做。理由成立：
开机静默改写用户的配置是危险动作。

但那条边界留下了一个**可观测的摩擦**：插件已经能看见原生行、也在状态里报警告
（`renderStatus` 的 conflict 段，原文就是 *"This gateway does not have it; add it here, or
disable the native row if you do not need it"*），而用户要做的事是**开一个终端、跑一条 npx
命令**。§8.1 已证明这个动作是一次性的，
但它仍然是「看得见问题」与「解决问题」之间的一道手工缝。

本命令把那道缝补上：**把 CLI 已经做对的事，搬到 GUI 里，由用户显式触发一次。**

**它不是自动接管。** 触发者仍然是人，写入仍然要显式 `apply`，默认仍然是干跑。
§7.2 的边界没有被越过——被越过的是「必须开终端」这一条。

### 0.1 「人」指的是谁（边界脚注）

`commands.execute` 只有前端经 remote 调用（`dsh-client-ui-commands` / `dsh-client-runtime` /
`dsh-api-session-controller`），**没有任何工具把它包出来**，所以模型和子代理都无法触发它——
模型只能走 bash 跑 CLI，那是改动前就存在的路径。

但这句话要读完：`dsh-im` 会把 IM 消息当命令派发（`dsh-im` 的 `harness-client.mjs`
`executeCommand`），可用性由 `access-policy.mjs` 的 `canExecuteCommands` /
`open.defaultCanExecuteCommands` 决定。而且**这条命令在宿主进程内直接写文件，不经过 tools 的
沙箱与审批链路**——在 `workspace-write` 策略下 bash 工具被挡着写不了 `~/.dsh/...`，
这条命令写得进去。这是它的功能，不是一个可以忘掉的副作用。

---

## 1. 事实核对（闸门 1）

每条关于框架/宿主行为的断言，都附可复现命令。取证版本：`@deepseek-ai/dsh-commands`
0.1.5-rc.1、`@deepseek-ai/cordis` 4.0.2、`@deepseek-ai/cordis-plugin-loader`、
`@deepseek-ai/dsh-app-boot`、`@deepseek-ai/dsh`（本机 `~/.bun/install/global/node_modules`）。

| 编号 | 事实 | 取证命令 |
| --- | --- | --- |
| G1 | 人类命令经 `ctx.commands.register(def)` 注册；`def.handler` 的返回类型是 `CommandResult \| Promise<CommandResult>`，**异步受支持** | `sed -n '37,52p' dsh-commands/lib/types/index.d.ts` |
| G2 | `CommandResult` = `{kind:'success'; text?; sourceEventSeq?} \| {kind:'error'; text}`；`CommandInputDescriptor` 的 `hint` 是**必填** | `cat dsh-commands/lib/types/types.d.ts` |
| G3 | `ctx.inject(deps, cb)` 是**可选/延迟绑定**：等价于 `ctx.plugin({inject, apply:cb})`，开一个子 fiber 等依赖，**不阻塞父插件激活** | `sed -n '104,112p' cordis/lib/types/registry.d.ts`；官方用例 20+ 处，如 `dsh-agent-default-model/lib/index.js:44` |
| G4 | web profile 已加载 `@deepseek-ai/dsh-commands`，且**未** disabled | `dsh --profile web --dump-config \| rg -n -A2 'id: commands'` |
| G5 | **profile patch 层是热重载的**：profile 的 `package.json` 声明 `patchReload: "live"`，宿主用 `watchUserPatches` 监视 `cordis.patch.yml` 与 home patch，变更即重新组合 | `rg -n patchReload ~/.dsh/profiles/web/package.json`；`sed -n '1109,1132p' dsh-app-boot/lib/index.js`；`sed -n '321,340p' dsh/lib/profile-boot-*.js` |
| G6 | `ctx.baseUrl` 是 cordis 的**公开**字段，且被 `boot()` 设为 profile 目录（`pathToFileURL(dirname(absoluteConfigPath))`） | `sed -n '20,24p' cordis/lib/types/context.d.ts`；`sed -n '1529p' dsh-app-boot/lib/index.js` |
| G7 | `dsh --profile <p> --dump-config` **不启动宿主、不加载插件、不求值 `!!js`**——只读 patch 文件并渲染 | `dsh/lib/dump-config-*.js` 模块注释：「compose the profile's patch layers … **without booting or evaluating `!!js`**」 |
| G8 | 热重载走 `entry.update()` → `internal/update` → `EntryGroup.update()`，后者只设 `this.data`，**不调用 `tree.write()`**，所以 `cordis.yml` 不会被展平 | `sed -n '86,103p' cordis-plugin-loader/lib/index.js`；本机 `~/.dsh/profiles/web/cordis.yml` 仍是 223 字节的 `[]` |
| G9 | patch 文件**解析失败会 fail loud**（抛错，不静默跳过），所以写入必须原子 | `sed -n '1146,1152p' dsh-app-boot/lib/index.js` |
| G10 | `scripts/adopt.mjs` 随包发布，可从 `lib/` 相对解析 | `jq .files package.json`；实机 `profiles/web/node_modules/dsh-mcp-lazy/scripts/adopt.mjs` 存在 |
| G11 | `main()` 在**写盘之后**才判 skips：`writePlan()` 先跑，再 `if (blocked > 0) return EXIT.skipped`。**退出码 1 意味着写入已经发生** | `sed -n '600,630p' scripts/adopt.mjs` |
| G12 | 宿主进程环境里 **没有 `DSH_*`**。`env \| rg '^DSH_'` 看到的是 `dsh-shell-env` 给**工具子进程**拼的 env，不是宿主自己的 | `tr '\0' '\n' < /proc/$(pgrep -f 'dsh web' \| head -1)/environ \| grep -c '^DSH_'` → 0 |
| G13 | `CommandRuntime.register` 走 `this.layers.effect(this.ctx, …)`，**随调用 fiber 自动卸载** | `sed -n '257,260p' dsh-commands/lib/index.js` |
| G14 | `npx dsh-mcp-lazy-adopt` 在干净机器上**曾经崩溃**：`lib/adopt-compose.js` 与 `lib/adopt-patch.js` 都 `import 'js-yaml'`，而它只声明在 `devDependencies` | `T=$(mktemp -d); mkdir -p $T/{scripts,lib}; cp scripts/adopt.mjs $T/scripts/; cp lib/*.js $T/lib/; (cd $T && node scripts/adopt.mjs --help)` → `ERR_MODULE_NOT_FOUND: Cannot find package 'js-yaml'` |

### 1.1 G5 的推论：这条命令是**即时生效**的

`watchUserPatches` 对**两个** patch 文件各注册一个 HMR 回调，变更时
`entry.update({config:{...includeConfig, patches}})` 把整份 patch 重读重组合。
所以命令写完文件后，宿主会自己把 `dsh-mcp-client` 行卸载、把服务器并进本插件的 `servers`。

**这条推论的代价必须一起说清楚**：G9 意味着**任何非原子的写入都会被解析器看见并抛错**。
所以本命令只能复用 CLI 已有的 **tmp + rename** 写入路径，不能自己造一条。

### 1.2 G12 的推论：profile 与 home 只能从 `ctx.baseUrl` 反推

`DSH_PROFILE` 不存在，`DSH_HOME` 在宿主进程里也不存在（G12）。唯一可靠的事实是 G6：
`ctx.baseUrl` = `<home>/profiles/<name>`。所以两侧都从它反推，并把 `--dsh-home` 显式传给 CLI，
让它们**按构造**一致，而不是各自解析一个 home。

两半都对不上 `<something>/profiles/<name>` 就**报错，不退回 `'web'`**——在别的 profile 里
静默写 web 的配置是「改不回来」那一类错误。

---

## 2. 决策

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| C1 | 命令**委托已发布的 `scripts/adopt.mjs`**，不重写组合逻辑 | 一条代码路径。CLI 的 71 项测试、备份/回滚/sha256/原子写全部直接复用；两条路径不会漂移。评审补充了更强的理由：CLI 的 `main()` 直接读 `process.argv.slice(2)`，`writePlan`/`digestOf`/`renderPlan` 都没导出，进程内调用要么污染宿主 argv/stdout，要么必须再导出写路径 |
| C2 | 用 **`ctx.inject(['commands'], cb)`**，不改插件的 `inject` | G3。改成 `inject: ['tools','commands']` 会让本插件在**没有 commands 服务的 composition 里永不激活**——MCP 网关整体消失，是最坏的回退 |
| C3 | 默认**干跑**，`apply` 才写 | 与 CLI 一致（D5）；`/mcp-adopt` 单独敲下去时用户还没决定 |
| C4 | 异步 spawn（`node:child_process` 的 `spawn`），**不用 `spawnSync`** | CLI 内部要再起一个 `dsh --dump-config` 进程，`spawnSync` 会**阻塞宿主的 event loop 数秒** |
| C5 | profile 与 home 从 `ctx.baseUrl` 反推并显式传参；取不到就报错 | §1.2 |
| C6 | 退出码 1（skips）映射为 **`success` + 一行警告**，不是 `error` | G11：写盘已经发生。UI 里把「部分成功」显示成红色错误会误导用户以为什么都没做 |
| C8 | 写入**不接受取消信号**；干跑接受 | CLI 的 `writePlan` 对两个文件连续 rename，之间被杀 = 「原生行已 disabled、server 还没 adopt」。干跑取消不花任何代价 |
| C9 | 写入成功后**再跑一次干跑**并把结果贴出来 | 「写好了」与「写好了，而且重新规划是这么看的」是两件事。这是用户唯一能核对的证据 |
| C10 | 每一次 CLI 调用都有**超时上限**（默认 120 s），且上限设在 handler 等待的那条缝上 | CLI 内部的 `spawnSync('dsh', …)` 没有 timeout；`--dump-config` 卡住会让命令永不 settle，GUI 一直转圈 |
| C11 | 计划里**显式报出跨 profile 的影响面** | 见 §2.1。这是评审发现的阻塞项 |

### 2.1 C11：被禁用的行常常在**共享层**

本机的真实情形：native 行 `mcp-codegraph-managed` 在 **home 层**（每个 profile 都读），
而 `id: mcp-lazy` 在 **web profile 层**。禁用它 = 顺手把 codegraph 从
`default` / `dsh-tui` / `headless` 手里拿走，而那些 profile 根本没挂本插件，
所以它们**只是失去能力，没有任何地方会说**。

计划本身看不见这件事——它从不看别的 profile。所以答案在渲染时算：遍历
`<dshHome>/profiles/*/package.json`，看谁的 `dsh.profile.bundles` 里没有 `dsh-mcp-lazy`。

选**报警告**而不是**拒绝**，因为本机的配置恰好就是这种跨层形态，拒绝等于这条命令在最需要它的
机器上不可用。警告点名受影响的 profile 并给出两条出路（在那些 profile 里也挂本插件，
或把行搬进当前 profile 自己的层）。

---

## 3. 接口

```ts
// src/command.ts —— 内部模块，不进 package.json 的 exports
export const ADOPT_COMMAND_NAME = 'mcp-adopt'

/** Which profile the host is running, and which home it belongs to. */
export interface HostProfile {
  readonly home: string
  readonly name: string
}

/** Injectable seams — every one has a production default. */
export interface AdoptCommandDeps {
  readonly scriptPath?: string
  readonly profile?: (ctx: Context) => HostProfile | undefined
  readonly run?: (args: readonly string[], signal?: AbortSignal) => Promise<AdoptRun>
  readonly timeoutMs?: number
}

/** Register the command. Rides the calling scope, so it returns nothing. */
export function registerAdoptCommand(ctx: Context, deps?: AdoptCommandDeps): void
```

**返回 `void` 不是设计疏漏，是 C2 的必然结果**：注册发生在 `ctx.inject` 的**延迟回调**里，
函数返回时 `register` 还没被调用，拿不到 disposer。注册的所有权在子 fiber 上——G13 证明
`CommandRuntime.register` 会自己把注册挂到调用它的那个 fiber 上，fiber 一拆命令就没了。

输入文法（`invocation.rawInput`，已 trim）：

| 输入 | 行为 |
| --- | --- |
| `` (空) | 干跑：`--profile <p> --dsh-home <h>` |
| `apply` | 真写：再加 `--write`；成功后追加一次干跑作为核对 |
| 其它任何输入 | `{kind:'error'}`，**零 spawn** |

---

## 4. 不变量（闸门 4）

| 编号 | 不变量 | 核对方式 | 实测 |
| --- | --- | --- | --- |
| J1 | 代理工具表面逐字节不变：1525 B / 11 参数 / 381 tokens | `测试` + `node scripts/measure-surface.mjs` | ✅ 1525 / 11 / 381 |
| J2 | 插件 `inject` 仍是 `['tools']` | `测试`（`plugin-load.test.ts`） | ✅ |
| J3 | **每一条发布产物里的裸 import 都在 `dependencies` 或 `peerDependencies` 里** | `测试`（`declared-deps.test.ts`，静态扫描 `lib/` 与 `scripts/`） | ✅ 修掉 G14 后通过 |
| J4 | 既有公开导出不减少（`createProxyTool` 等签名不变） | `测试` + 全量套件 | ✅ |
| J5 | 干跑与「参数错误」两条路径**零写入** | `测试`（比对 patch 文件 sha256） | ✅ |
| J6 | 不新增 inject 服务 | `测试`（J2 同一条） | ✅ |

> **J3 的原文是错的，这一版是修正后的。** 原文写的是「运行时不新增依赖：仍只有
> `@modelcontextprotocol/sdk`」，判定命令 `jq '.dependencies|keys'` 只看「声明有没有变」，
> **看不见**「代码 import 了没声明的东西」——而那正是 G14。现在它检查的是后者。

---

## 5. 验收标准（闸门 2）

| 编号 | 标准 | 判定命令 | 实测 |
| --- | --- | --- | --- |
| AD16 | `commands` 服务**延迟出现**时命令仍会注册；插件不等它（真 cordis） | `node --test test/unit/adopt-command.test.ts` | ✅ 无 commands 时 `mcp` 已注册；`provide` 后 `mcp-adopt` 出现 |
| AD17 | 空输入 = 干跑，参数字面量**不含** `--write` | 同上 | ✅ `['--profile','web','--dsh-home','/home/tester/.dsh']` |
| AD18 | `apply` = 真写，参数字面量**含** `--write` | 同上 | ✅ |
| AD19 | 未知输入 → `{kind:'error'}` 且 `run` **零调用** | 同上 | ✅ |
| AD20 | CLI 退出码 2 → `{kind:'error'}`，文本携带 CLI 自己的消息 | 同上 | ✅ |
| AD21 | CLI 退出码 1 → `{kind:'success'}`，文本含跳过提示与 CLI 原文 | 同上 | ✅ |
| AD22 | CLI 退出码 0 → `{kind:'success'}`，文本等于 stdout | 同上 | ✅ |
| AD23 | `ctx.baseUrl` 缺失或不是 `<home>/profiles/<name>` → `{kind:'error'}` 且 `run` 零调用 | 同上 | ✅ |
| AD24 | spawn 失败（ENOENT / 抛异常）→ `{kind:'error'}`，**不抛到 handler 外** | 同上 | ✅ |
| AD25 | 插件**不在**自己的 ctx 上读注册表；注册只发生一次 | 同上 | ✅ |
| AD26 | 真文件级：默认 runner 跑真实 CLI，干跑后两个 patch 文件 sha256 不变 | `test/unit/adopt-command.test.ts`（真实脚本 + stub `dsh`） | ✅ |
| AD27 | 真文件级：`apply` 后 home 层多一行 `disabled: true`、profile 层多出服务器条目，注释保留 | 同上 | ✅ |
| AD28 | J1 表面不变 | `plugin-load.test.ts` + `node scripts/measure-surface.mjs` | ✅ |
| AD29 | J2/J6 不变 | `plugin-load.test.ts` | ✅ |
| AD31 | 干跑**转交**取消信号；写入**不转交** | `adopt-command.test.ts` | ✅ |
| AD32 | 写入成功后**重跑干跑**并在结果里贴出结论；重跑失败/仍报有活 → 如实说明 | 同上 | ✅ |
| AD33 | runner 永不 settle 时按上限放弃，GUI 不会被挂住 | 同上（40 ms 预算） | ✅ |
| AD34 | 被禁用的行在 home 层时，计划**点名**会失去该能力的其它 profile | 同上 | ✅ 真机干跑输出点名 `default, dsh-tui, headless` |
| AD30 | 干净环境复现：`rm -rf lib node_modules && pnpm install --frozen-lockfile && pnpm run check && pnpm test` | 同左 | 见 §9.3 |

---

## 6. 已知不做

1. 不做自动接管（`adopt-native-rows.md` §7.2 的边界不变）。
2. 不做 GUI 卡片按钮（§7.3）。
3. 命令不自己组合配置树，也不自己写文件（C1）：它只调用 CLI 并翻译退出码。
4. 不支持 `--json`、`--file`、`--allow-skip` 等 CLI 旗标。
5. 不改 `@hyzyn/dsh-codegraph` 的任何设置。
6. `src/command.ts` 是**内部模块**，不进 `package.json` 的 `exports`：接口里的 injectable seams 是
   给测试的，不是给使用者的公开 API。

---

## 7. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| **跨 profile 静默丢失能力** | 在 web 里 apply 一次，`default`/`dsh-tui`/`headless` 一起失去 codegraph，无报错 | C11：计划里点名受影响的 profile 与两条出路（AD34） |
| 写入与 `dsh-config-manager` 抢写 | 后写的赢，先写的静默丢失 | 复用 CLI 的 sha256 预检 + tmp/rename；**只挡住「先写」方向**——config-manager 事后用自己内存状态整份重写仍会吞掉改动，命令无法察觉。用 `/mcp-adopt` 复查可见 |
| 写入途中被取消 | 「原生行已 disabled、server 还没 adopt」 | C8：写入阶段不接受取消（AD31） |
| 新配置让插件 `apply` 抛错 | `Entry.update` 走 rollback，最坏情况命令和 `mcp` 工具一起消失 | 原子写只防「解析失败」，不防「语义失败」。`src/adopt.ts` 直接 import `KNOWN_SERVER_FIELDS`/`MCP_CLIENT_ONLY_FIELDS`（不是复制），所以「CLI 接受的字段 == 运行时接受的字段」成立 |
| 命令注册被 `commands` 拖住 | MCP 网关整体不激活 | C2（AD16 覆盖，且跑真 cordis） |
| `dsh --dump-config` 卡住 | 命令永不 settle，GUI 一直转圈 | C10：handler 层超时（AD33）+ 默认 runner 杀子进程 |
| 猜错 profile 写错文件 | 改到别的 profile 的配置 | §1.2：反推 + 显式传参 + 取不到就报错（AD23 覆盖） |
| 热重载正好由本命令触发 | handler 还在 await 时，它自己的注册被拆掉重建过一次 | 结果仍能落回 UI（`execute()` 已拿到定义，`command/done` 由 `CommandRuntime` 自己的 ctx 追加）。`Entry.update` 先 dispose 旧 fiber（连带 `ctx.inject` 子 fiber）再 re-apply，所以是一次注销 + 一次注册，不重复 |
| 宿主不是 Node | `process.execPath` 假设它是 Node（Bun 勉强能跑，SEA/Electron 打包形态会得到莫名其妙的结果） | 只记在这里，不处理：DSH 的受支持宿主就是 Node |
| 配置写入后热重载解析失败 | 宿主 fail loud | G9：只走 CLI 的原子写（AD26/AD27 断言字节结果） |

---

## 8. 实施结果

见 §9。

---

## 9. 实施结果与验证（闸门 5）

### 9.1 新增与改动

| 文件 | 变化 |
| --- | --- |
| `src/command.ts` | 新增，约 330 行：命令注册、输入文法、退出码翻译、超时、重规划核对 |
| `src/index.ts` | +1 import，+1 调用（`registerAdoptCommand(ctx)`，在 teardown effect 之前） |
| `src/adopt-compose.ts` | 新增导出 `LAZY_PACKAGE = 'dsh-mcp-lazy'` |
| `scripts/adopt.mjs` | 新增 `profilesLosingService()`（并导出）与 `renderPlan` 的跨 profile 警告块 |
| `package.json` | `js-yaml` 从 `devDependencies` 移到 `dependencies`（修 G14） |
| `test/unit/adopt-command.test.ts` | 新增，25 项 |
| `test/unit/declared-deps.test.ts` | 新增，3 项（J3/G14 的静态回归） |
| `test/unit/plugin-load.test.ts` | 替身补 `inject`；新增一条「唯一可选依赖是 commands」的断言 |
| `test/unit/connection.e2e.test.ts` | 两处替身补 `inject` |

### 9.2 证据

- **验红（feature 不存在）**：加测试后首次运行 →
  `ERR_MODULE_NOT_FOUND: Cannot find module '.../lib/command.js'`，exit 1。
- **验红（声明依赖）**：把 `js-yaml` 挪回 `devDependencies` → `declared-deps.test.ts`
  3 项中 2 项变红，断言文案为「the adopt CLI is a published bin entry, so its YAML parser
  belongs in dependencies」；挪回 `dependencies` 后复绿。
- **真实脚本级**：`adopt-command.test.ts` 的最后一块用**真实 `scripts/adopt.mjs`**
  加 stub `dsh` 跑完整流程——干跑零字节变化、`apply` 后 home 层出现 `disabled: true`、
  profile 层出现 `serverName: codegraph`、注释保留、重规划报 `0 server(s) to move`。
- **真机干跑**（零写入，未改任何配置）：

  ```
  1 server(s) to move, 1 row(s) to disable, 0 row(s) needing no action, 0 blocked
    adopt   codegraph (from mcp-codegraph-managed in ~/.dsh/cordis.patch.yml)
    disable mcp-codegraph-managed (codegraph) in ~/.dsh/cordis.patch.yml

    ⚠ the row being disabled lives in the home layer ~/.dsh/cordis.patch.yml, which every profile reads.
      3 other profile(s) do not mount dsh-mcp-lazy, so they would lose codegraph with no replacement:
      default, dsh-tui, headless.

  Dry run. Nothing was written; pass --write to apply.
  ```

### 9.3 干净环境复现

```bash
rm -rf lib node_modules .pnpm-store
pnpm install --frozen-lockfile      # exit 0
pnpm run check                      # exit 0
pnpm test                           # exit 0
```

**这次复现不是走过场**：它第一次跑就抓到一条 `src/` 的类型检查看不见的错——
`pnpm run typecheck` 只查 `src/`，而 `check` 里的 `test:types` 会连测试一起查，
于是 `test/unit/adopt-command.test.ts` 里那个多传的 `attachments` 字段
（`error TS2353`）只有在这里才暴露。已修。

### 9.4 数字

| 项 | 值 |
| --- | --- |
| `pnpm run check` | exit 0 |
| `pnpm test` | **305 tests / 73 suites，0 fail**（实施前 277 / 66） |
| 新增用例 | `adopt-command.test.ts` 25 项、`declared-deps.test.ts` 3 项 |
| 代理工具表面 | 1525 B / 11 参数 / 381 tokens（J1 未变） |
| 运行时依赖 | `@modelcontextprotocol/sdk`、`js-yaml`（后者为修 G14 而加） |
| 变异验红 | **8/8**：每一条载荷决策都有一个用最小改动就能弄红它的测试，见 §9.6 |

### 9.5 没做的那一层验证（如实记录）

`repo-workflow` 阶段 6 要求两层 e2e：**组件 e2e**（真依赖 + 假宿主）与**宿主集成验证**
（真挂进运行中的宿主）。**第二层没有做。**

- 已做的是第一层，而且做得比较硬：真 `scripts/adopt.mjs`、真 `dsh --dump-config`（stub）、
  真文件系统、真 cordis `Context`（AD16 那条）。
- 没做的是：把新构建装进一个**跑着的** web profile，敲一次 `/mcp-adopt`，看它出现在命令补全里、
  看 `apply` 之后热重载真的把 `dsh-mcp-client` 那行卸掉。

为什么没做：宿主此刻正跑着本会话，而插件**代码**变更需要**重启宿主**才生效
（`patchReload: live` 热重载的是位置解析，不是插件代码）。这属于「要用户点头」的动作。

**所以：`/mcp-adopt` 在当前运行的宿主里还不存在**——profile 里装的是已发布的 0.2.1，
命令是本工作树里的新代码。在装上并重启之前，任何「它已经能用了」的说法都是没有依据的。


### 9.6 变异验红

`.tmp/red-proof-command.mjs` 对 `src/command.ts` 与 `scripts/adopt.mjs` 逐个施加
「只删掉这一条决策」的最小改动，**重建后**再跑套件，并要求**指名的那条测试**变红
（改的是 `src/`、验证的是构建产物，两个环节都覆盖到）。实测：

```
default becomes a write instead of a dry run                red on the expected test
an unknown verb falls through to a dry run                  red on the expected test
the registry is read off the plugin context instead of …    red on the expected test
a partial move is reported as an error                      red on the expected test
an underivable profile is guessed as web                    red on the expected test
the cancellation signal is forwarded into the write         red on the expected test
a write is not re-planned, so the result carries no …       red on the expected test
the cross-profile blast radius is not computed              red on the expected test

8/8 mutations caught by the intended test
```

---

## 10. 对抗性评审与修正记录

方案在实施前后各经过一轮**独立子代理对抗性评审**（`code-review` 的四轴法）。评审报出
**2 条阻塞 + 6 条重要 + 5 条次要**；两条阻塞都经**独立复核**（不是照单全收）：

| 编号 | 发现 | 我的复核 | 处理 |
| --- | --- | --- | --- |
| F1（阻塞） | 跨 profile 静默丢失：native 行在 home 层、`mcp-lazy` 在 profile 层，禁用会让别的 profile 失去能力 | ✅ 复核：只有 `web` 挂了本插件，而三个 profile 都读到那条 home 行 | C11 + AD34：渲染时点名受影响的 profile |
| F2（阻塞） | CLI 依赖未声明的 `js-yaml`，`npx` 在干净机器上崩 | ✅ 复核：仓库外隔离副本 → `ERR_MODULE_NOT_FOUND: Cannot find package 'js-yaml'` | 移进 `dependencies`，J3 改写，加静态回归测试 |
| F3（重要） | 写入途中被取消 = 半个配置 | ✅ 复核：`writePlan` 对两文件连续 rename，CLI 无信号处理 | C8 + AD31 |
| F4（重要） | `DSH_HOME` 不在宿主进程环境里，守卫空转；G12 取证被工具子进程的 env 污染 | ✅ 复核：`/proc/<host>/environ` 里 `DSH_` 计数为 0 | §1.2 + C5：从 `baseUrl` 反推并显式传 `--dsh-home` |
| F5（重要） | AD16 用手搓假 ctx，没验证「无 commands 时 `mcp` 照常注册」 | ✅ 复核：替身 `inject` 只记录不执行 | 改用**真 cordis `Context`** 重写该用例 |
| F6（重要） | 没有「生效了没有」的可核对证据 | ✅ 复核：`renderPlan` 收了 `digests` 却从不打印 | C9 + AD32：写入后重跑干跑并贴出结论 |
| F7（重要） | 写入无互斥，且没承认 CLI 的「停机再跑」建议 | ✅ 复核：CLI USAGE 原文确实这么写 | §7 如实记下**只能挡「先写」方向**，并给出复查手段 |
| F8（重要） | §3 的签名 `(): () => void` 不可实现 | ✅ 复核：实现已退化为 `void` | §3 改正并写明原因（C2 的必然结果）+ G13 |
| F9–F13（次要） | 验收表指错文件、无超时、§9 空着、新模块不在 exports、`process.execPath` 假设 | — | AD26/27 路径改正；C10 + AD33；§9 回填；§6.6 标注 internal；§7 记一行 |

评审同时明确认可 C1（并给出比原文更强的理由）、C2、C4、C6、G5、G9 与原子写，
以及「热重载后命令不会丢也不会重复注册」这一条结论。
