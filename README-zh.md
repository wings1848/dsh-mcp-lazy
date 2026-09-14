# dsh-mcp-lazy

[![CI](https://github.com/wings1848/dsh-mcp-lazy/actions/workflows/ci.yml/badge.svg)](https://github.com/wings1848/dsh-mcp-lazy/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-mcp-lazy.svg)](https://www.npmjs.com/package/dsh-mcp-lazy)
[![node](https://img.shields.io/node/v/dsh-mcp-lazy.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/dsh-mcp-lazy.svg)](https://github.com/wings1848/dsh-mcp-lazy/blob/main/LICENSE)
[![English](https://img.shields.io/badge/docs-English-blue.svg)](https://github.com/wings1848/dsh-mcp-lazy/blob/main/README.md)

一个给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的**懒加载 MCP 网关**：模型面前只有
**一个**工具，而不是 N 个 MCP 工具的 schema。服务器用到才启动、闲下来就回收，工具元数据落盘缓存
—— 所以 `search` 和 `describe` 不启动任何进程。

![一个工具而不是 N 个：原生注册每次请求都发送全部工具 schema 且所有服务器常驻；dsh-mcp-lazy 只发送一个恒定 schema，用到才启动服务器](https://raw.githubusercontent.com/wings1848/dsh-mcp-lazy/main/docs/assets/how-it-works.svg)

## 为什么

`@deepseek-ai/dsh-mcp-client` 在启动时连接每一个配置的服务器，并把它们的全部工具注册成原生工具。
它自己的 README 说得很直白：工具描述和输入 schema「在工具注册期间会进入每一次请求」。于是几台服务器
就等于每次请求几千 token，外加每台一个常驻子进程——无论模型是否真的调用过它们。

本插件把模型可见的工具面固定为**一个** schema 永不变化的工具，工具按需从磁盘缓存里发现，只有真正
需要时才拉起服务器。

## 实测数字

对 `chrome-devtools-mcp@1.6.0`（29 个工具）实测，两边用同一种算法（工具定义的 JSON 字节数，再按
4 字节 ≈ 1 token 估算）：

| | 每次请求 |
| --- | --- |
| 原生注册 | 21252 字节 ≈ **5313 token** |
| 本插件 | 1525 字节 ≈ **381 token** |
| 省下 | **92.8%** |

这个 381 是**恒定值**：再挂十台服务器它也不动，因为那些 schema 变成了「要用时才读」。

**要说清的代价。** 网关的成本是固定的 1525 字节，所以只有当某台服务器渲染出来的工具定义超过这个数
它才划算。仓库自带的 fixture 只有 7 个小工具，省下的就只有 1.7%。一台只有两三个迷你工具的服务器会让
网关变成净亏损。上之前先量一下自己的：

```bash
pnpm run measure:savings                                          # 本地 fixture
node scripts/measure-token-savings.mjs --npx <你的服务器>
```

## 安装

```bash
dsh plugin --profile <你的profile> add dsh-mcp-lazy
```

这条命令会把包装进 profile 并登记它的 bundle patch，后者插入 `mcp-lazy` 这一行。然后在 profile 的
`cordis.patch.yml` 里填服务器：

```yaml
- id: mcp-lazy
  config:
    servers:
      - serverName: chrome
        transport: stdio
        command: npx
        args: ['-y', 'chrome-devtools-mcp@1.6.0']
        lifecycle: lazy
      - serverName: docs
        transport: streamable-http
        url: http://127.0.0.1:3000/mcp
```

重启 profile 即可。每个字段的说明见 [docs/configuration.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/configuration.md)（英文）。

### 从 `@deepseek-ai/dsh-mcp-client` 搬过来

这个生态里写 MCP 配置的各方**都产出 `@deepseek-ai/dsh-mcp-client` 行**：config-manager 面板写死了
这个包名、`@hyzyn/dsh-codegraph` 会写一条托管行、手写配置也照这个惯例来。这种行会把每个 MCP 工具
注册成**真原生工具**，schema 因此进入每一次请求 —— 而同一台服务器在两边都配着，省 token 的效果就
**静默归零**（不报错、不冲突，只有 `mcp({})` 的状态输出会提示你）。

`adopt` 命令替你做这次搬迁：

```bash
dsh-mcp-lazy-adopt                 # 干跑：只打印计划，什么都不写
dsh-mcp-lazy-adopt --write         # 落盘，每个文件先留一份带时间戳的备份
```

不想离开会话的话，也可以用 slash 命令：

```
/mcp-adopt                         # 干跑
/mcp-adopt apply                   # 落盘
```

命令驱动的是同一个 CLI，所以计划、备份、写入只有一条代码路径；`apply` 成功后会自动**再跑一次干跑**
并把结果贴给你，「到底生效了没有」是证据而不是保证。它仍然要人敲一下 —— 插件启动时什么都不做。

它读的是**实际挂载了什么**（`dsh --profile <p> --dump-config`，四层 patch 全部组合过），
把原来的行**就地**标成 `disabled: true`，再把服务器追加进本插件的 `servers` 列表。文件里**别的字节
一个不动** —— 注释、空行、`!!js` 表达式全部逐字节保留；搬不动的行会给出**原因**而不是靠猜。
请在宿主**停机时**执行：web profile 的 patch 层是热重载的，而 `dsh-config-manager` 也会整份重写
同一个文件。

**动手前先看影响面。** native 行通常住在 **home 层**（每个 profile 都读），而本插件的行只在一个
profile 的层里。所以禁用前者会**顺手把服务器从其它 profile 手里拿走**，而那些 profile 根本没挂本插件，
只会静默失去能力。计划会点名它们：

```
  ⚠ the row being disabled lives in the home layer ~/.dsh/cordis.patch.yml, which every profile reads.
    3 other profile(s) do not mount dsh-mcp-lazy, so they would lose codegraph with no replacement:
    default, dsh-tui, headless.
    Mount dsh-mcp-lazy in those profiles, or move the row into web's own layer, if they need it.
```

如果那些 profile 也需要这台服务器，先在那里也挂上本插件（或把行搬过去）再落盘。

有两个字段本插件**没有实现** —— `reconnect` 和 `failOnStartupError`。带这两个字段的行会被报成
`unsupported-field` 并**原样留下**（不会搬、也不会禁用），所以加载不会因为一个「看起来配了、其实没
生效」的设置而失败。字段名拼错同理；行自己的 `id` 会被丢掉，因为它命名的是加载器那一行、不是服务器。

## 模型看到的工具

只有一个，11 个参数，永远不变：

```
mcp({ search: "screenshot" })          # 找工具 —— 走缓存，不启动任何东西
mcp({ describe: "take_screenshot" })   # 看完整参数 schema
mcp({ tool: "take_screenshot" })       # 调用 —— 这一步才会拉起服务器
mcp({ tool: "echo", server: "docs" })  # 两台服务器有同名工具时消歧
mcp({ connect: "chrome" })             # 只连上并刷新缓存，不调用
mcp({ instructions: "chrome" })        # 服务器自己的说明
mcp({})                                # 状态：工具数 / 连接态 / 缓存年龄
```

11 个里，7 个就是上面这些动作。剩下 4 个只用来调节 `search`，别的地方用不到：

| 参数 | 含义 | 默认值 | 上限 |
| --- | --- | --- | --- |
| `regex` | 把 `search` 当正则表达式，而不是字面文本。 | `false` | — |
| `includeSchemas` | 在结果里带上每个命中工具的参数字段摘要。 | `true` | — |
| `limit` | 返回多少条命中。 | `12` | `40`；写大了会被裁到 40，不报错 |
| `offset` | 跳过前多少条命中，用来翻长结果。 | `0` | — |

默认情况下，这一个工具就是**全部**模型可见的工具面。`directTools` 是可选项，
能把挑出来的服务器工具提升成真正的原生工具 —— 它能取哪些值、以及为什么默认更省，
见 [docs/configuration.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/configuration.md)。

## 文档

| | |
| --- | --- |
| [docs/configuration.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/configuration.md) | 每个字段、四种生命周期、输出上限 |
| [docs/troubleshooting.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/troubleshooting.md) | 启动失败、冷缓存、名字解析 |
| [docs/development.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/development.md) | 构建、测试、为什么 `link-dsh` 是必须的 |
| [docs/design/plan.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/design/plan.md) | 实现计划与验收标准 |
| [docs/design/adopt-native-rows.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/design/adopt-native-rows.md) | `adopt` 命令：设计、不变量、验收标准，以及实施时才发现的事 |
| [docs/design/mcp-adopt-command.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/design/mcp-adopt-command.md) | `/mcp-adopt` slash 命令，以及改动了它的那轮对抗性评审 |
| [docs/design/parity-pi-mcp-adapter.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/docs/design/parity-pi-mcp-adapter.md) | 与 `pi-mcp-adapter` v2.33.0 的逐模块审计 |

> 详细文档目前只有英文版。这份中文 README 是入口页。

## 已知不做（v1 边界）

- **只桥接 tools**。不做 MCP resources / prompts / sampling / elicitation，只订阅 `tools/list_changed`。
- **不做 OAuth**。认证靠明文 `headers` 或环境变量。
- **图片/音频结果不转发像素**。会被投影成一行元数据（类型 + 字节数）。真正进会话需要 attachment 存储。
- **不做审批门**。MCP 调用走 DSH 自己的权限预设。
- **不做配置互操作**。只读 DSH 原生 config；不导入 `.mcp.json`、Cursor、Claude Code、Codex、VS Code。
- **正则安全闸比 pi 弱**。只有 256 字符长度上限 + 嵌套无界量词检测，**不**覆盖重叠选择分支
  （`(a|aa)+`）和多项式级回溯（`a*a*a*b`）。要完整分析就得加第二个运行时依赖。
- **不支持 SSE 和 unix socket**。只有 `stdio` 和 `streamable-http`。
- **不把 `npx` 解析成真实二进制**，所以用 `npx` 拉起的服务器会多一个 Node 父进程。

## 开发

```bash
pnpm install
pnpm test          # 构建 → 重链 peer 包 → 305 个用例
pnpm run check     # typecheck（含测试）→ build
```

见 [CONTRIBUTING.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/CONTRIBUTING.md)。

## Star 趋势

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/wings1848/dsh-mcp-lazy/output/star-history-dark.svg">
  <img alt="Star 趋势图" src="https://raw.githubusercontent.com/wings1848/dsh-mcp-lazy/output/star-history-light.svg">
</picture>

## 许可

MIT，见 [LICENSE](https://github.com/wings1848/dsh-mcp-lazy/blob/main/LICENSE)。连接层与环境洗白规则改自 `@deepseek-ai/dsh-mcp-client`；单代理网关、
元数据缓存、加权搜索排名改自 `pi-mcp-adapter`。两者都是 MIT，声明重印在
[THIRD_PARTY_NOTICES.md](https://github.com/wings1848/dsh-mcp-lazy/blob/main/THIRD_PARTY_NOTICES.md)。
