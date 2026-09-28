# dsh-wait-guard

主 Agent 的**出口闸门**：只要还有后代子代理处于 `running`，它的 turn 就不允许结束。

这是一个**纯 Host 插件**：不注册工具、不改配置、不写文件、无全局状态。删掉这个 bundle，一切立刻恢复原样。

[English](README.en.md)

---

## 0. 安装（用户）

**从 GitHub 直接安装**（不需要 npm，已在隔离 profile 实测）：

```sh
# 跟随 main
dsh plugin --profile <你的 profile> add github:dn4hjtcr9s-del/dsh-wait-guard

# 固定版本（推荐：可复现）
dsh plugin --profile <你的 profile> add github:dn4hjtcr9s-del/dsh-wait-guard#v0.1.0
```

**从 npm 安装**（若已发布到 npm，命令更短）：

```sh
dsh plugin --profile <你的 profile> add dsh-wait-guard
```

或在 Web UI 里：**Plugins → Add plugin** → 把上面 `add` 后面的那一段粘进去即可。新装 bundle 会通过 HMR 生效；**替换已安装的包需要重启**才能加载新的模块代。

卸载：在同一页面移除，或 `dsh plugin --profile <你的 profile> remove dsh-wait-guard`。

装好后无需任何配置即可工作：默认 60 秒静默提醒一次、任何消息到达立刻退场。要改行为就改 bundle 行的 `config`（见 §5）。

> 下面 §1–§10 是设计与验证细节（保证边界、配置、宿主机制、实测记录、已知边界、版本变更）。§3 是**开发者的本地挂载方式**，普通用户不需要看。

---

## 1. 保证与不保证

| | |
|---|---|
| ✅ **保证** | 任何会委派的 Agent，其 turn 不会在**整棵后代树**里还有 `running` 时结束 —— 包括"中间层 idle、孙代理在跑"的情形 |
| ✅ 保证 | **暂停期间任何消息到达都立刻让插件失效**：人的消息、子代理的汇报、子代理的结算通知，一律立即交给模型处理。**失效 = 插件完全退场**（停止等待、不注入任何东西），那一步完全归模型自由使用 |
| ✅ 保证 | **失效是临时的**：模型下一次想收尾时，只要还有子代理在跑，闸门立刻重新生效（所以失效只有两条路径：**消息到达** 或 **时间到**） |
| ✅ 保证 | 消息**投递**从不经过本插件；子代理发给其它 agent 的消息与本插件无关，永不受影响 |
| ❌ 不保证 | 模型不产出中间文字（允许，且这通常是有价值的 —— 每次到达都会给它一次思考机会） |
| ❌ 不阻止 | 模型主动 `interrupt_agent` 掐掉工作（那是它的判断；掐掉会产生结算通知，等待随之结束） |
| ⚙️ 可选 | 若你想要"结果攒齐一次性给模型"的旧行为，把 `releaseOn` 设为 `['user','agent-message']`（见 §5） |

粒度是 **turn 级**：闸门管的是"不许收尾"，不是"不许说话"。

---

## 2. 为什么是安全的（可审计）

| 约束 | 实现方式 |
|---|---|
| **零依赖** | `lib/index.js` **没有任何 `import`** —— 不解析任何模块，因此不会因为打包环境/解析规则差异而失败。消息对象按运行时接受的结构手工构造（会话层对 `user/message` 载荷不做结构校验，只要求可 JSON 序列化） |
| **零写入** | 不碰 settings、不碰 profile、不碰文件、不调用 `session.append` |
| **零全局状态** | 不 monkey-patch、不注册工具、不加 `tools.guard`、不改任何服务 |
| **监听器随插件销毁** | 全部通过 `ctx.on` / `ctx.inject` 注册，Cordis 在插件卸载时自动回收 |
| **定时器不泄漏** | 每次轮询的 `setTimeout` 都被登记；插件卸载时逐一 `clearTimeout` |
| **在途等待立刻解除** | `ctx.effect` 注册的清理器会把所有挂起的等待 resolve 掉 —— **卸载插件不会把正在等待的 turn 卡死** |
| **失败开放** | 读不到子代理列表时默认放行（`onProbeError: 'open'`），可改为 `'closed'` 严格模式。理由：一个"卡住且无法解除"的闸门比漏拦一次更糟 |
| **不阻断排队的人消息** | 若本次放行的唯一原因是 `next-turn` 里的排队消息，**绝不注入**任何提醒 —— 否则会占住 `next-step`，把那条消息又推迟一步 |
| **可选的唯一持久痕迹** | 提醒类消息（nudge / companion）作为普通 `user/message` 进入对话历史 —— 这是**会话内容**，不是配置状态；一次收尾尝试最多一条 nudge，companion 受 `maxCompanionPerTurn` 限制 |

自审命令（应当**没有输出**）：

```sh
cd /Users/kebofeier/Documents/deepseek
grep -nE "^import |require\(|node:fs|ctx\.tools\.register|session\.append|ctx\.settings" _dsh-wait-guard/lib/index.js
```

（文件头的文档注释里会出现 "settings" 这个词，那是说明文字而非代码，所以上面的模式限定为 `ctx.settings`。）

---

## 3. 开发者：本地挂载与重载

> 普通用户请用 §0 的 `dsh plugin add`。本节只用于**在源码树上直接调试**。

插件目录：`/Users/kebofeier/Documents/deepseek/_dsh-wait-guard/`——它本身就是一个可安装的 bundle（`package.json` 声明 `dsh.bundle.patch` → `cordis.patch.yml`）。

**推荐的开发姿势：把这个目录当 bundle 装**（官方路径：`plugin_manager` 的 `install_bundle`，target 传包目录绝对路径；CLI 同理）：

```sh
# 装进某个 profile（会走 pnpm，写 profile 的依赖记录与 patch）
dsh plugin --profile <你的 profile> add /Users/kebofeier/Documents/deepseek/_dsh-wait-guard
```

**不污染日常环境的烟测**（推荐，任何修改后先跑这个）：

```sh
export PATH=/opt/homebrew/bin:$PATH
DSH_HOME=/tmp/dsh-smoke dsh plugin --profile smoke add /Users/kebofeier/Documents/deepseek/_dsh-wait-guard
```

`DSH_HOME` 指向临时目录，profile 与依赖全部落在 `/tmp`，**绝不触碰 `~/.dsh`**；跑完 `rm -rf /tmp/dsh-smoke` 即可。

**当前这台机器上的实际挂载**是 home 级 overlay `~/.dsh/cordis.patch.yml`（base patch 注释里指定的 overlay 位置，对所有 profile 生效）——那是**直接指文件**的开发挂法：

```yaml
- insert:
    - id: wait-guard
      name: '/Users/kebofeier/Documents/deepseek/_dsh-wait-guard/lib/index.js'
      config:
        firstWaitMs: 60000
```

两种挂法**不要同时用**：会出现两个实例（重复的提示段落、成倍的提醒）。改用 bundle 时，先删掉这个 overlay 行。

**挂载层的说明**：`agent/turn-stopping` 是 scope 过滤事件，而 `dsh-scope` 的派发规则是「**未打标签的监听器全局接纳；事件只向上流**」。顶层 patch 行是 host 平面、无 scope 标签，因此**能收到所有 Agent 的这个事件**，不需要改任何 preset。

**生效方式（实测过的坑，务必照做）**：

| 改动 | 是否需要重启应用 |
|---|---|
| patch 里的 `config` | ❌ 不需要，`dsh-hmr` 热重载配置（实测立即生效） |
| `lib/index.js` 里的**代码** | ✅ **需要**（或按下面的"免重启重载"走） |

原因：`dsh-hmr` 默认 `root: []`，**只监视 patch 文件、不监视模块文件**；而且**加载器按行 id 复用已导入的运行时**，所以只改 `name` 也无效。

**免重启重载**（迭代时很有用，实测有效）：新建一个**从未被导入过**的入口文件，同时把行 id 也换新：

```js
// lib/entry-N.js
export * from './index.js?v=N';   // 查询串必须一起递增
```

```yaml
- insert:
    - id: wait-guard-vN          # 新行 id → 旧条目销毁、新条目重新导入
      name: '.../lib/entry-N.js' # 新入口路径 → 全新模块 URL
```

⚠️ **千万不要把查询串写进 `name`**（例如 `name: '.../lib/index.js?v=N'`）：宿主把 `name` 当**文件路径**转 `file://` URL，`?` 会被转义成 `%3F` → 找不到文件 → **插件静默不加载**（已实测复现：闸门消失，提前回答立刻收尾）。查询串只有写在模块**内部的静态 import** 里才安全 —— 那一段由 Node 的 ESM 解析器按 URL 处理。

重启应用后可以改回 `name: '.../lib/index.js'`，并删掉 `entry-*.js`。判定当前生效版本的办法见 §8。

**若绝对路径解析失败**（桌面版可能使用内置模块导入器），按顺序试：

1. 相对路径：把插件目录放到 profile 内，`name: './plugins/wait-guard/lib/index.js'`（加载器以 profile 目录为 `baseUrl`）；
2. 作为本地包安装：在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里加 `"@local/dsh-wait-guard": "file:/Users/kebofeier/Documents/deepseek/_dsh-wait-guard"`，执行 `pnpm install`（profile 是 `nodeLinker: hoisted` 的 pnpm 项目），然后 `name: '@local/dsh-wait-guard'`。

---

## 4. 卸载

删掉 `~/.dsh/cordis.patch.yml` 里那一行 insert，或整个文件。**没有其他任何需要还原的东西**：插件不修改配置、不写文件；在途等待会在卸载瞬间被解除，不会留下卡住的 turn。

---

## 5. 配置项

| 字段 | 默认 | 含义 |
|---|---|---|
| `firstWaitMs` | `60000` | 静默多久算"该提醒了"。**每次收尾尝试单独计时**：到点就注入 **1 条**提醒并立即退场 |
| `nudge` | `true` | 是否启用"时间到"这条失效路径。设 `false` = 纯静默闸门（只等，不说话） |
| `pollMs` | `250` | 轮询间隔（等待时长按**墙钟**计，不受探测耗时影响） |
| `releaseOn` | `['*']` | `'*'` = **任何消息到达都让插件失效**（默认）。设为 `['user','agent-message']` 则结算通知不触发失效、会攒到齐 |
| `companionReminder` | `false` | **默认关闭**：到达即完全失效，插件一个字都不加。设为 `true` 才在 `next-step` 到达时额外注入一句"别当成最终结论"（与到达者同批被领取，零额外请求） |
| `maxCompanionPerTurn` | `2` | companion 提醒的每轮上限 |
| `policySection` | `true` | 是否往系统提示注入规则段落 |
| `onProbeError` | `'open'` | 读不到列表时：`open` 放行 / `closed` 继续等 |
| `policyText` | 内置英文 | 策略段落文本 |
| `nudgeText` | 内置中文 | 超时提醒模板，支持 `{n}` `{s}` `{list}` |
| `companionText` | 内置中文 | 放行伴随提醒，同上 |

> **已废除（v5）**：`waitFactor` / `maxWaitMs`（递增间隔）与 `maxNudgesPerTurn`（每轮上限）、`giveUpAfterMs` / `giveUpText`（限时放弃）。它们在"注入即退场"的设计下要么永不生效、要么只会让后续尝试沉默扣住；留着只会误导。配置里写了也会被忽略，不影响加载。
| `debug` | `false` | 输出诊断日志 |

---

## 6. 多层级覆盖

待办探测走**整棵后代树**：

```
running = listDescendants(agent.id).filter(e => agents.get(e.id)?.status === 'running')
```

- 因此「中间层 idle（在 turn 之间）、但它自己的子代理在跑」也会让闸门保持关闭 —— 这正是单看直系子代理会漏掉的情形；
- `listDescendants` 不可用时退化为 `listChildren`；
- **对每一层生效**：任何会委派的 Agent（包括子代理自己，当递归深度调大时）都被拦；
- 状态取自 Agent 注册表的原始状态（`running` / 其他），**不依赖** `list_agents` 工具面向模型的两态投影。

> 补充：新版默认「最大递归深度 = 1」（只有主 Agent 能派子代理），所以默认树只有两层；但本插件不为这个默认值做任何假设。

---

## 7. 行为时间线（v4）

```
step N: 模型说"我不调工具了" → 该 step 返回 completed → turn 准备收尾
   派发 agent/turn-stopping（serial、被 await）
     ├─ 无 running 后代 → 立刻返回，turn 正常结束                      ← 常态
     └─ 有 running 后代 → 闸门生效，暂停在这里
          ├─【失效路径 1：消息到达】结算通知 / 子代理汇报 / 用户消息
          │     → 插件【完全退场】：停止等待，且不注入任何东西
          │       （这一步完全属于模型：可以思考、调工具、也可以先答一版）
          ├─【失效路径 2：时间到】静默满一个间隔
          │     → 注入 nudge 后立即退场
          │       （停在门后的提醒永远无法被领取 —— v2 的缺陷）
          │       每次收尾尝试都重新计时；一次尝试只提醒一条，无配额、无递增
          ├─ nudge: false → 这条路径关闭，闸门完全静默（只等）
          └─ 全部结算 → 退场
   收尾复查：next-step 非空 → 不结束，再跑一个 step
              next-step 为空 → 结束（此时必然没有 running 后代）

模型若再次尝试收尾 → 重新派发 agent/turn-stopping → 只要还有 running 后代，
闸门【立刻重新生效】。所以"失效"总是临时的：turn 的收尾权始终被扣着。
```

要点：**放行 ≠ 收尾**。每次放行后模型会得到一步去处理消息；如果它又想收尾而仍有子代理在跑，闸门立刻重新关上。整轮依然只会在最后一个子代理结算之后才真正结束。

---

## 8. 自测与"当前生效版本"判定

```sh
npm test                              # = 下面两个都跑
node test/self-test.mjs               # 功能：22/22
node test/package-shape.mjs           # 包体契约：7/7
```

**功能自测**用一个假 host 上下文驱动真实插件代码，覆盖：无待办 / 单层等待 / **多层级（idle 协调者 + running 孙代理）** / **到达即完全失效（不注入任何东西）** / **失效是临时的：下一次收尾尝试立刻重新生效** / **V4 来源准入（companion 与 nudge 两种消息都验）** / opt-in companion / **opt-in 攒批模式下结算通知不放行** / 子代理汇报即失效 / 用户队列消息失效且不注入 / **墙钟计时（慢探测下仍在 firstWaitMs 处提醒）** / **nudge 必须退场** / **每次收尾尝试各提醒一条（无配额、无递增）** / `nudge:false` 静默 / 取消立即返回 / **卸载立即解除在途等待** / 探测失败开放与关闭两种模式 / 策略段落条件注入 / 配置容错 / 消息 id 唯一与 summary 截断。当前 **22/22 通过**。

**包体契约自测**校验安装器在运行前会读的东西：`dsh.bundle.patch` 指向存在、exports/files 里每个路径都存在、Host-only（无 dependencies、无会被运行时版本比对的 `@deepseek-ai/dsh*` peer）、locale 的 `meta.title/description` 齐备、icon 是包内相对路径且 ≤256 KiB、patch 恰好 insert 一行且 `name` 等于包名、入口无 import/无写入。当前 **7/7 通过**（环境里装了 `js-yaml` 时会做真实 YAML 解析，否则退化为结构检查）。

**判断宿主当前跑的是哪个版本**（改了模块文件却不确定是否已重导入时）：

| 观察 | 结论 |
|---|---|
| 暂停期间**每条**到达都让模型立刻多走一步，且**插件一个字都不加** | v4 已生效 |
| 到达能立即多走一步，但会多出一句"注意：仍有 N 个子代理在运行…" | v3（`companionReminder` 那时默认还是 true） |
| 多个子代理时，全部通知在**最后一个结算的同一时刻**一次性出现 | v2 或更早（配置层热更新有效、模块没重新导入） |
| 全程没有任何 `source.kind = wait-guard` 的消息 | 插件未加载（旧版 `kind:'plugin'` 会被 V4 硬拒） |

---

## 9. 已知边界

1. **子代理永不结算 = 主 Agent 一直等**。出路：时间到的提醒会让模型有机会用 `interrupt_agent` 叫停；用户也可以随时"停止"；想要纯静默就把 `nudge` 设成 `false`。
2. **默认策略下每次到达都会消耗一次模型请求**（这是"立刻处理消息"的代价）。想要省请求就把 `releaseOn` 设成 `['user','agent-message']`，让结算通知攒齐。
3. **模型仍可能产出中间文字**：闸门只保证 turn 不结束。
4. **不阻止中断**：模型可以掐掉工作再收尾 —— 这是刻意保留的判断自由。
5. **提醒消息会留在历史里**：每条提醒都是真实对话内容。到达路径**默认不注入任何东西**（`companionReminder: false`）；把 `nudge` 设成 `false` 就是完全静默的闸门。
6. **不覆盖非 continuable 的一次性子代理**：它们无法续跑、也不会发结算通知，一律在 `list_agents` 之外；本插件只看活着的 Agent 状态。

---

## 10. 版本变更

| 版本 | 变更 |
|---|---|
| v1 | 初版：闸门 + `{kind:'plugin', plugin:'wait-guard'}` 来源的提醒 |
| v2 | 修 V4 准入：`source.kind` 直接命名生产者（`wait-guard`）。旧的 `plugin` 包装被 session format V4 **硬拒**（拒绝写入 / 让日志不可读） |
| v3 | ① 等待时长改用**墙钟**（原来只累加 sleep，实测偏慢约 2 倍）；② **nudge 注入后立即放行**（原来停在门后，模型永远看不到）；③ 放行策略改为**任何到达都结束暂停**（`releaseOn: ['*']`），并保留 opt-in 攒批；④ 修回"`next-turn` 到达时不注入"的规则，避免推迟用户的排队消息；⑤ companion 文案带 `{list}` |
| **v4** | **失效语义定稿**：消息到达 = 插件**完全退场**（停止等待，且**不注入任何东西**），那一步完全归模型自由使用（思考 / 调工具 / 先答一版都行）；模型下次想收尾时，只要还有子代理在跑，闸门**立刻重新生效**。为此 `companionReminder` 默认改为 `false`（想要那句提醒才设 `true`），并新增"失效是临时的"回归测试。失效只有两条路径：**消息到达** 或 **时间到** |
| **v5** | **时间路径简化定稿**：删掉三处已失效的旧旋钮 —— `waitFactor` / `maxWaitMs`（递增间隔在"注入即退场"后永不生效）、`maxNudgesPerTurn`（每轮配额只会让第 4 次以后的收尾尝试沉默扣住，与你"每次收尾独立计时"的语义冲突）、`giveUpAfterMs` / `giveUpText`（限时放弃）。现在只有一条规则：**每次收尾尝试单独计时，静默满 `firstWaitMs` → 注入恰好一条 → 立即退场**；`nudge: false` 关闭该路径（纯静默闸门）。提醒频率天然被"模型自己要收尾"这件事限住 |
| **v5.1（打包）** | 变为可分发的 **bundle**：`package.json` 声明 `dsh.bundle.patch`、`icon`、`locale/{en,zh}.json` 显示元数据、`exports`/`files` 按官方契约；新增 `test/package-shape.mjs` 包体契约自检。**已在隔离 profile 实测** `dsh plugin add <目录>` 成功，组合树中出现 `id: wait-guard` 行 |

---

## 11. 发布（上架社区）

DSH **没有官方市场**，事实标准是三件事：**GitHub（带 `dsh-plugin` topic）+ npm 包 + 去社区目录/Discussions 曝光**。

仓库信息已写进 `package.json`：

```
repository  https://github.com/dn4hjtcr9s-del/dsh-wait-guard
```

### 已就绪

- 本目录已是**独立 git 仓库**（`main` 分支，含首个提交），可直接推上去；
- `npm view dsh-wait-guard` 返回 **404 → 包名可用**（未被占用，可以发无 scope 包）；
- 包体契约自检会拒绝占位符和非法 `repository`，所以不会把 `<owner>` 之类发出去。

### 需要你本人做的三步

```sh
# ① 推仓库（gh 未安装；先 brew install gh && gh auth login，或直接在网页建仓库再 push）
gh repo create dsh-wait-guard --public --source . --push
gh repo edit --add-topic dsh-plugin          # ← 社区的发现机制，收录列表都按它抓

# ② 登录 npm（要账号 + 两步验证码，命令会停下来问你）
npm login

# ③ 首发（同样是交互式，OTP 必须你自己输）
npm publish
```

> 想在 CI 里发版就用 npm 的 **Trusted Publishing**（在 npmjs.com 上给你的包配置 GitHub Actions 作为发布者），之后 `git tag v0.1.1 && git push --tags` 就能自动发；配置这一步也只能你来。
> 官方模板 [dsh-plugin-template](https://github.com/exoticknight/dsh-plugin-template) 把这三步写成了可交给 agent 执行的 playbook（含 CI、tag 保护、Trusted Publisher 配置），要省事可以照它走。

### 可以交给我的部分

| 事项 | 说明 |
|---|---|
| 起草 GitHub Release 说明 / Discussions 发布帖 | 中英双语，含安装命令、保证与边界、实测证据 |
| 起草 awesome 列表的收录 PR 文案 | 按各列表的 CONTRIBUTING 格式（表格行 + 安装命令 + 一句话简介） |
| 打 tag、写 CHANGELOG | 需要在 `gh` 登录之后 |
| 后续改代码、发新版本的版本号与文档同步 | 每次同步 §10 变更表 |

### 发布前检查

`npm test` 全绿（22/22 + 7/7）→ `package.json` 的 `version` 与 git tag 一致 → §3 的隔离烟测确认"用户视角安装"可用 → 打 topic。

**版本号**：当前 `0.1.0`。改代码后记得同步 §10 的版本变更表。


