# `output_matches` 正则求值 ReDoS 基准（#81 第 1.1 条）

- **原 issue**：[#81](https://github.com/zzjcool/pi-async/issues/81)「仍需要」表第 12 行（`1.1 output_matches 执行超时`，P3，未拆）
- **基线**：`main` `3fc1bb7`
- **本条是「只测不改」**：`src/`、`extensions/`、`tests/`、`docs/CONTRACT.md` **零改动**；新增仅
  `scripts/redos-bench.mjs` 与本文件
- **数字出处**：§3–§6 的**测量值**全部来自**同一次运行**，原始 stdout 逐字附在附录 A。凡引用别的运行、
  别的工具（`time` / `uptime`）或他人复算的数字，都在原地标了出处。跑法见 §7.1

## 1. 结论：**B — 量得到**

> 正则求值在 64K 尾部窗口上**可以被挂死**，而且不需要 64K：
>
> - `(a|a)*$` + 主体 `"a"*29 + "!"`：**30 码元**在**热路径**（第二圈以后的轮询）被 5 s 硬杀
>   （同次运行 28 码元 = 3.10 s）；按 **冷路径**（watcher **第一次**轮询的真实形态，第 1 次调用）
>   算，**26 码元** = **5.02 s**。
> - 三档长度（1 024 / 8 192 / 65 536）对三种越狱形状**全部 KILLED**；控制组 0.02–0.33 ms。
>
> **64K 上限对工作量没有任何约束作用**：1 024 码元就已经被杀，而 `(a|a)*$` 在 64K 主体上要走
> Σ₂ᵏ = 2^65535−1 量级的路径（不是"超一点"）。现有唯一防线是形状黑名单（`src/core/watch.ts:25`），
> 4 个给定形状里**放过 3 个**；求值全同步（`src/core/watch.ts:265-277`），挂住的是**宿主进程本身**
> （§5（2）用定时器实测）。

按 issue 的判据（"存在形状被杀或 > 1s"），为 **B**。

## 2. 环境与可信度

| 项 | 值 |
|---|---|
| node | v22.22.3（V8 12.4.254.21-node.56）；引擎下限从 `package.json` 的 `engines` 读出 = `22.19.0`，开跑前由 child 探测 |
| 机器 | Apple M1 Pro ×10，darwin/arm64，Darwin 27.2.0 |
| 运行时长 | **1 min 47 s**（由 shell 的 `time` 测得；脚本自身不报墙钟） |
| 负载 | load average **3.06 → 2.52**（由 shell 的 `uptime` 测得；脚本不报负载） |
| 求值入口 | `evalConditions()`（`src/core/watch.ts:120`）——与 `WatchLoop.check()` / `registry.ts:466` 同一条路径，含 `matchSubject()` 的 64K 截断 |
| 主体上限 | `MAX_MATCH_CHARS` = 65536 **UTF-16 码元**（`src/core/watch.ts:18`） |
| 对抗主体 | `"a" * (n-1) + "!"`，即 n 个码元、末位是不匹配尾巴 |
| 硬超时 | 主表/曲线 5 000 ms、冷表与 series 15 000 ms，`spawnSync({ timeout, killSignal: "SIGKILL" })`——**没有**靠外部 `timeout` 命令，脚本自足 |
| 杀的判定 | 必须 `error.code === "ETIMEDOUT"` **且** wall clock ≥ 预算；wall 毫秒**印在表格里**。非超时的 SIGKILL / 任何 child 失败一律记 `ERROR`、打印 `ERROR detail: <stderr 首行>`、进程退 1 |
| 冷/热 | 主表/曲线是**热路径**（先对 1 码元主体跑一次）；**冷路径**（第 1 次调用）单列 §4.2，另附 6 连调曲线（§4.3） |

## 3. 主表：三档长度 × 7 个形状

`blacklist` 列不是人眼判断，是拿**真实校验器** `validateWatchSpec()` 跑出来的结果；BLOCKED 的格子
**根本没被求值**（脚本直接跳过，计入"validation-blocked slots"）。

| 形状 | 正则 | 黑名单 | 1 024 | 8 192 | 65 536（上限） |
|---|---|---|---|---|---|
| `(a\|a)*$` | `(a\|a)*$` | passes | **KILLED** | **KILLED** | **KILLED** |
| `(a+)+$` | `(a+)+$` | **BLOCKED** | 不求值 | 不求值 | 不求值 |
| `(a\|aa)+$` | `(a\|aa)+$` | passes | **KILLED** | **KILLED** | **KILLED** |
| `(.*a){20}$` | `(.*a){20}$` | passes | **KILLED** | **KILLED** | **KILLED** |
| `^(a\|a)*$`（探索） | `^(a\|a)*$` | passes | **KILLED** | **KILLED** | **KILLED** |
| `(a\|a)*$` 无尾巴（对照） | `(a\|a)*$` | passes | 0.03 ms match | 0.05 ms match | **0.24 ms** match |
| `ready\|done`（对照） | `ready\|done` | passes | 0.02 ms | 0.03 ms | **0.06 ms** |

12 个 KILLED 格子的证据一律是 `ETIMEDOUT` + `SIGKILL / exitCode null`、wall 5 003–5 006 ms
（**没有一次自然返回**；5 s 是测量上限，不是测到的耗时）。

**黑名单命中情况（原样回答 issue 的"顺带确认"）**：4 个给定形状里**只有 `(a+)+$`** 被现有守卫挡住
（`NESTED_QUANTIFIER` = `\((?:[^()\\]|\\.)*[+*]\)\s*[+*]`，`src/core/watch.ts:25`）。
`(a|a)*$`、`(a|aa)+$`、`(.*a){20}$` 都能通过校验、都能挂死，结论只按这三个算。

## 4. 曲线：最小可挂输入

### 4.1 热路径

| n（码元） | `(a\|a)*$` | `(a\|aa)+$` | `(.*a){20}$` |
|---|---|---|---|
| 10 | 0.04 ms | — | — |
| 12 | 0.07 ms | — | — |
| 14 | 0.23 ms | — | — |
| 16 | 0.84 ms | — | 0.91 ms |
| 18 | 3.21 ms | — | — |
| 20 | 12.9 ms | 0.30 ms | 14.3 ms |
| 22 | **47.7 ms** | — | **54.7 ms** |
| 24 | 192.9 ms | 1.86 ms | 219.8 ms |
| 26 | 780.1 ms | — | 882.3 ms |
| 28 | **3.10 s** | 11.9 ms | **3.53 s** |
| 30 | **KILLED** | — | — |
| 32 | — | 81.7 ms | **KILLED** |
| 40 | — | **3.87 s** | — |
| 48 | — | **KILLED** | — |
| 64 | — | **KILLED** | — |

读数（只写实测点，不插值）：

- `(a|a)*$` 是纯指数（约 ×2/码元）：20 → 12.9 ms、22 → 47.7 ms、24 → 192.9 ms、28 → 3.10 s、30 被杀。
- `(a|aa)+$` 是 Fibonacci 底（φⁿ≈1.618ⁿ），需要更长的主体：32 → 81.7 ms、40 → 3.87 s、48 被杀。
- `(.*a){20}$` 与 `(a|a)*$` 同档：22 → 54.7 ms、28 → 3.53 s、32 被杀。
- 对照组说明**长度不是变量、尾巴才是**：同一个 `(a|a)*$`、同一个 64K 主体，把末尾的 `!` 换成 `a`
  （首次贪心路径就成功）只要 **0.24 ms**；良性正则跑满 64K 是 **0.06 ms**。

### 4.2 冷路径：watcher 的**第一次**轮询贵约 6×（3.3–7.8×）

`validateWatchSpec` 只是把 `new RegExp` 缓存进 `compiledRegexes`（`src/core/watch.ts:97`），**从未执行过**；
第 1 次调用的代价是后续调用的 ~6 倍（§4.3 证明这是一次性的，不是曲线）。上表为了让"求值代价"可比，
先对 1 码元主体跑了一次——那等于给真实场景的**第二圈**计时。同一次运行里并排
（冷列预算 15 s，所以 5 s 的量能测出真值而不是被 5 s 杀线截断）：

| 主体 | 冷（第 1 次调用） | 热（预热后） | 比 |
|---|---|---|---|
| `ready\|done`，64K（对照） | 0.14 ms | 0.06 ms | 2.4× |
| `(a\|a)*$` 无尾巴，64K（对照） | 0.33 ms | 0.24 ms | 1.4× |
| `(a\|a)*$`，18 码元 | 19.7 ms | 3.29 ms | 6.0× |
| `(a\|a)*$`，19 码元 | 39.0 ms | 6.58 ms | 5.9× |
| `(a\|a)*$`，20 码元 | 78.2 ms | 12.1 ms | 6.5× |
| `(a\|a)*$`，21 码元 | 160.6 ms | 24.7 ms | 6.5× |
| `(a\|a)*$`，22 码元 | 315.2 ms | 47.7 ms | 6.6× |
| `(a\|a)*$`，24 码元 | 1.28 s | 192.4 ms | 6.6× |
| **`(a\|a)*$`，26 码元** | **5.02 s** | 781.4 ms | 6.4× |
| `(.\*a){20}$`，20 码元 | 45.9 ms | 14.0 ms | 3.3× |
| `(a\|aa)+$`，28 码元 | 94.3 ms | 12.1 ms | 7.8× |

读法（三条都重要）：

- **对病态形状**：冷路径把"被 5 s 杀"的门槛压到 **26 码元**（热 30），把"越过 25 ms 预算"的门槛压到
  **18–19 码元**（18 = 19.7 ms < 25，19 = 39.0 ms > 25）。§4.1 是**下界**，真实第一圈更糟。
- **对良性/正常命中的形状**：冷路径只贵 1.4–2.4 倍，绝对值仍是**亚毫秒**（0.14 / 0.33 ms）。所以
  "良性 64K 很快"这个对照结论不因冷暖而变。
- **冷 ≠ 与生产完全同形**：`cold` child 把 `new RegExp` 也算进去（生产里 `validateWatchSpec` 已预编译）。
  这部分向上偏差实测 **0.006 ms**（三次独立进程：0.0060 / 0.0058 / 0.0059 ms），在 39 ms 面前可忽略——
  它是**偏保守**，不是偏乐观。

### 4.3 那 6× 是一次性成本，不是"越来越快"的曲线

同一个 `RegExp` 对象连调 6 次（`(a|a)*$`，18 码元，未预热）：

```
#1 19.4 ms  #2 3.31 ms  #3 3.28 ms  #4 3.18 ms  #5 3.27 ms  #6 3.19 ms
```

第 1 次贵 6×，第 2 次起就**持平**（3.18–3.31 ms）。所以 §4.2 的"冷/热"是**第 1 次 vs 第 2 次**的差，
之后不再变。生产含义：每个 watch 的第一轮求值最贵（且只贵这一次），之后每轮都是热值。

**最小可挂输入（可直接抄，数值取自同一次运行的**冷**列——独立进程第一次调用就是这个代价）**：

```js
// 越 25 ms 预算：19 码元（冷 39.0 ms）
evalConditions([{ type: "output_matches", regex: "(a|a)*$" }],
  { output: "a".repeat(18) + "!", stdout: "", stderr: "" });
// 越 50 ms 预算：20 码元（冷 78.2 ms）
evalConditions([{ type: "output_matches", regex: "(a|a)*$" }],
  { output: "a".repeat(19) + "!", stdout: "", stderr: "" });
// 越 5 s：26 码元（冷 5.02 s）；热路径版本要 30 码元
evalConditions([{ type: "output_matches", regex: "(a|a)*$" }],
  { output: "a".repeat(25) + "!", stdout: "", stderr: "" });
// 满窗口版本：64K 码元，热/冷同样 KILLED
"a".repeat(65535) + "!"
```

注意：把上面任一行直接拷进 `node -e` 跑，得到的是**冷**值（进程刚起、正则没跑过）；想复现 §4.1 的热值
需要先对同一 `RegExp` 跑一次小主体。脚本的 `--child` 默认也是冷，`--child … <tail>` 后加参数不加 `cold`
才会先预热。

## 5. 两个必须写进报告的事实

**（1）`(a|a)*$` 最终会「匹配成功」——不是"匹配不上所以慢慢放弃"。**
`(a|a)*` 允许零次重复，所以穷举完指数条路径之后，引擎在**偏移 n 处**以一个零宽匹配成功。它在数据里
出现在**曲线表的 `match` 列**（n=10..28 每行都是 `match`）与**停顿 demo**（`matched=true`）。
和 `m` 标志**无关**：去掉 `m`，`new RegExp("(a|a)*$").test("a"*9+"!")` 同样返回 `true`（他人复算，
`flags=""`，`exec` 给出第 9 位的零宽匹配）——真正的原因是 `test()` 未锚定 + 该分支可空。含义：挂死之后
watch 还会**真的命中**并 `markWatchSuccess`，所以这既是"最坏情况"，也是一次"看起来完全正常"的求值。
（主表里这些格子显示 `SIGKILL/exit null`，是因为被杀**在返回之前**；只有活下来的行才能看到 `matched`。）

**（2）`timeoutMs` / `intervalMs` 救不了，因为挂的是整个事件循环。**
`WatchLoop` 的 `timeoutMs` 是 `setTimeout` 墙钟，只在 `check()` 入口与 `scheduleNext()` 被读到
（`src/core/watch.ts:164-169`、`:216-227`），而这两处都在同步求值**返回之后**才可能执行。
实测（默认就跑，`--no-clock-demo` 可关）：先把一个 100 ms 的定时器上弦，再对 28 码元主体求值——

```
eval returned after      : 3.12 s (matched=true)
the 100 ms timer fired at: 3.12 s after the arm
verdict                  : STALLED — nothing else in the process ran during the evaluation
```

推理边界（不夸大）：这条只证明"100 ms 的定时器没能抢在求值返回前跑"。加上 JS 单线程，才能推出"期间
同进程任何回调都没跑"——pi 的 TUI、其它任务的 `readWatchOutput`、通知投递，以及这个 watch 自己的超时
检查。若求值本身 < 100 ms，demo 打印 `INCONCLUSIVE`（脚本已这么处理）；若 demo 自己被预算杀掉，打印
`KILLED … inconclusive`。所以这不是"一条 watch 慢"，是"宿主 agent 冻结"，且每个 `intervalMs`（≥1000 ms）
都会重来一次。

## 6. 结论 B 的交付项（**不实现**，只给设计要点）

### 6.1 建议阈值

| 量 | 实测（同一次运行） | 建议 |
|---|---|---|
| 良性 64K 求值 | 0.06 ms（冷 0.14 ms） | — |
| 良性形状跑满 64K | 0.24 ms（冷 0.33 ms） | — |
| 病态形状越过 25 ms | 冷 19 码元（39.0 ms）；热 22 码元（47.7 ms） | **每轮求值预算 25 ms** |
| 病态形状越过 50 ms | 冷 20 码元（78.2 ms）；热 24 码元（192.9 ms） | 若取 50 ms 也够，代价是晚一两个码元发现 |

25 ms 相对真实工作量有 ~75–100× 余量（0.24 → 25 ms；冷 0.33 → 25 ms 仍有 ~75×），而三种病态形状都能在
**28 码元以内**越过它（冷：`(a|a)*$` 19、`(.*a){20}$` 20、`(a|aa)+$` 28）。

推荐 **25 ms**，并**必须由可抢占的执行上下文实现**：在同进程里"求值完再检查耗时"是无效的（§5（2）已
证明期间什么都跑不了）。50 ms 也能用，但没有任何数据支持"必须给到 50"。

### 6.2 要改的文件（按实际引用点核过，不是估的）

| 文件 | 位置 | 改什么 |
|---|---|---|
| `src/core/watch.ts` | `:120-123`、`:241-253`、`:255-303`、`:164-206` | `evalConditions` / `evaluateConditionsDetailed` / `evaluateCondition` 变异步或搬去 worker；`WatchLoop.check()` 必须 `await`，`finish()` 之后不得再 `scheduleNext()` |
| `src/core/registry.ts` | `:466-467`（进程退出路径的同步 `evalConditions`）、`:345-388`（`attachWatch` 构造 `WatchLoop`） | 退出路径在 `live.exit.then` 里，能 `await`，但**必须重新检查 `isTerminal(task.status)`**（见 REV-R5） |
| `src/core/task.ts` | `:32`（`Condition`；`output_matches` 成员在 `:37`）/ `WatchSpec` | 若加 per-eval 预算字段或新的"求值超时"语义 |
| 新文件（若选 worker 隔离） | `src/core/regex-worker.ts` | worker 生命周期 + 消息协议；每轮要把 ≤64K 码元传过去 |
| `src/tools/index.ts` | `:167` | `watch` schema / description，仅当新增旋钮或新的终态文案 |
| `src/core/notify.ts` | `:32`、`:50` | `failureKind` 投影，仅当新增 `regex_timeout` 之类 |
| 测试 ×4 | `tests/b-watch-conditions.test.ts`、`tests/b-watch-validate.test.ts`、`tests/b-watch-integration.test.ts`、`tests/w2-safety.test.ts` | 全仓 `evalConditions(` 共 **24 处调用点**（22 在 `tests/`、2 在 `src/`）+ 1 处声明，都要加 `await` 或改 async 断言 |
| 文档 | `docs/CONTRACT.md` §4（`:126-183`，其中 `:159` 是"限制 ReDoS 影响面"那句；同类措辞还在 §20.2 的 `:1164`）、`README.md:271-272`、`skills/async-tasks/SKILL.md:92`、`CHANGELOG.md` | 见 REV-R2（现有措辞已被本报告证伪） |

量级与 issue 的估计一致：**2 个核心源文件（+1 个可选 worker 文件）+ 1 个类型文件 + 4 个测试文件
+ 4 个文档**；其中真正需要**设计**的只有前两行，其余是机械跟进。

### 6.3 REV 要点

- **REV-R1 超时算什么状态**（最关键，且现行契约没覆盖）。`output_matches` 现在只有
  `matched / pending / error`（类型 `src/core/watch.ts:236-239`，`case "output_matches"` 在 `:265-277`）。
  求值超时时：算 `error` → 吃 `blind_checks` 预算（REV-2 的"仅计基础设施失败"用到错误原因上，模糊）；
  还是第一次超时就直接终结 watch？**建议：首次超时即 `failed` + `failureKind: "regex_timeout"` + kill
  进程组**，落进 REV-4 那条既有家族（`failure_when` / blind 耗尽 / watch timeout 三条都杀）。
  理由：形状是确定性的，重试没有新信息；且这样**不动 REV-2**（blind 仍只计"读追加失败"）。
- **REV-R2 现状措辞已被证伪，必须改。** `docs/CONTRACT.md:159`（§4）与 `:1164`（§20.2）把 64K 窗口的
  **理由**写成"以限制 ReDoS 影响面"；`src/core/watch.ts:13` 的注释写"catastrophic patterns cannot grow
  without bound"。实测：19 码元就过 25 ms、26 码元过 5 s。窗口仍该留（它砍的是**字节量**），但 REV 必须把
  "限制 ReDoS 影响面"删掉或改写为"不是工作量上界"。
- **REV-R3 黑名单的定位**。现有守卫只认"组以量词收尾再叠量词"（`(a+)+`），4 个给定形状过 3 个。
  即使补上"含 `|` 的组 + 量词"（能挡 `(a|a)*`/`(a|aa)+`），仍挡不住 `(.*a){n}` 一类"有界重复套 `.*`"。
  形状匹配永远不完备 → REV 必须写明它是**深度防御**，不是防线；防线是运行期预算。
- **REV-R4 用户可见语义**。`validateWatchSpec`（`registry.ts:346-347`、`:400`）在**建任务前**拒绝并回显
  修复动作；超时只能事后发现 → REV 需要定：通知/`async_status` 里怎么显示、`failureKind` 叫什么、
  是否在 SKILL.md 补一句"`output_matches` 每轮有求值预算，宽泛的 `*`/`|` 组合请用 `stdout_contains`"。
- **REV-R5 异步化后新出现的交错**。退出路径那段不变量现在只是注释（`registry.ts:458-460`："a terminal
  snapshot is the record"）。`await` 之后同一个 task 可能已被 watch timeout / 用户 kill / generation
  retire 终结 → 恢复执行时必须重新 `isTerminal` 判定，否则会重写终态快照。
- **REV-R6 成本与相邻问题**。`readWatchOutput`（`registry.ts:691`）每轮同步读 8 MiB 尾部（REV-25），
  它自己就是一次小停顿，和正则预算是同一类问题；REV 需要说明为什么这次只处理正则（或一并处理）。
  worker 隔离的每轮拷贝成本（≤64K 码元）也应记一笔。

## 7. 复现与可信度

### 7.1 跑法

1. 全跑（主表 + 3 条曲线 + 冷/热表 + 6 连调 + 停顿 demo，本报告的数字来源）：
   `node --experimental-strip-types scripts/redos-bench.mjs` —— **1 min 47 s**，
   70 个测量槽位 / 67 次真正 spawn（3 个被校验拦住）/ 16 次 SIGKILL。
2. 只看主表：`--no-ladder --no-cold --no-clock-demo`（12 次 SIGKILL，约 65 s）。
3. 调预算：`--hard-timeout 5000 --cold-hard-timeout 15000`；改长度：`--sizes 1024,8192,65536`；
   想跳过某张表：`--no-ladder`（曲线 + 6 连调）、`--no-cold`、`--no-clock-demo`。
4. 单个数据点：`--child <regex> <size> <tail|no-tail> [cold] [series:N]`，例如
   `node --experimental-strip-types scripts/redos-bench.mjs --child '(a|a)*$' 26 tail cold`、
   `… --child '(a|a)*$' 18 tail cold series:6`。参数缺失/畸形会直接报错退出（不会静默测一个空正则）；
   正则编译不了会输出 `{"error": …}` 并退 2。
5. 原始 JSON：`--json`（全跑时含 `env` / `rows` / `ladderRows` / `coldRows` / `seriesRun` / `clockDemo` /
   `errors`；某个键缺席就表示那张表没跑）。探测失败时 `--json` 也会输出一个带 `probeError` 的对象
   （不是空 stdout + 退 2）。

### 7.2 脚本自身的防呆（因为一次静默错误就会把结论翻成 A）

- **探测**：开跑前先用同一命令跑一个 4 码元 child；失败就打印原因（含 node 版本 vs `engines` 下限）并退 2，
  **不产出任何表格**。
- **杀的判定**：`ETIMEDOUT` + wall ≥ 预算双证据，wall 毫秒直接印在表格里；非超时的 SIGKILL 记 `ERROR`。
- **非超时失败**：记 `ERROR` + 打印 `ERROR detail: <stderr 首行>`（不只在 `--verbose` 下）+ 进程退 1。
- **"什么都没测到"**：若主表所有格子都被校验拦住，打印 `FAIL: no main-table cell was actually evaluated`
  并退 1——不会出现"全 BLOCKED 但绿灯"。
- **对账**：`measurement slots / children spawned / ok / killed / errors / validation-blocked` 一行给全，
  "槽位"与"真的 spawn 过"分开计（被校验拦住的格子不算 child）。

### 7.3 未测 / 边界

- `stdout`/`stderr` 分流的求值（同一函数、同一窗口，不改变结论）；PCRE/RE2 类引擎对照；真实 TUI 卡顿
  （§5（2）的推论，未做端到端复现）。
- 64K 这一档取 `size == MAX_MATCH_CHARS`，走的是 `matchSubject()` 的 `length <= cap` 直通分支，
  **没有**触发 `slice(-cap)` 那条路（内容相同，代价差异在微秒级，不影响结论）。
- 只测了正则求值，没测 `readWatchOutput` 每轮 8 MiB 同步读自身的停顿（REV-R6 提到，未量化）。
- "第一次调用贵 6×"的**机制**没查（是 V8 正则分层还是别的）；本报告只陈述现象与"第 2 次起持平"这条实测。

### 7.4 什么会让结论翻转（诚实边界）

**结论 B 不依赖任何边界格子**：1 024 / 8 192 / 65 536 三档是被**指数**杀的（`(a|a)*$` 在 1 024 码元上已是
2^1023−1 量级路径），换一台快 10 倍的机器照样杀。会被机器速度改变的是**曲线里的近邻格子**：

- `(a|aa)+$` n=40 = **3.87 s**，距 5 s 只有 ~1.1 s（约 29%）——慢 ~30% 的机器会把它变成 `KILLED`，
  于是"48 码元被杀"前移到 40。
- `(a|a)*$` n=28 = 3.10 s（同理可能前移到 28 被杀）。
- 冷表 26 码元 = 5.02 s **就在 5 s 线附近**，但它的预算是 15 s，所以这个格子只会改变**数值**，
  不会改变分类（它测的是"真值是多少"，不是"会不会被杀"）。

所以请把曲线读作"**这台机器上**的界"，而不是普适常量。离散度（所有例子都能在附录 A 里找到）：

- **同一次运行内**，同一量测两次最多差 ~6%：n=20 热 12.9（曲线）/ 12.1 ms（冷表 warm 列）；
  n=18 热 3.21 / 3.29 ms；n=26 热 780.1 / 781.4 ms；冷 18 19.7（冷表）/ 19.4 ms（6 连调的 `#1`）。
- **跨运行**差 ~2–8%：n=22 热 47.7 ms（本次）vs 51.5 ms（上一次运行）。
- 这些差都不改变任何一档分类；最敏感的是 n=22 的"是否已过 50 ms"（47.7 未过），已在 §4.1 用"实测点"写法
  避免把它写成结论。

## 8. 仓库健康检查（证明这次没碰坏东西）

本次改动只有两个**新增**文件（`scripts/redos-bench.mjs`、本文件）。`git status` 只剩这两个 `??`；
没有改任何 `.ts`。

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（`tsc --noEmit`） | **exit 0，无诊断** |
| `npm test` | **489 tests / 460 pass / 16 fail / 13 skip** |
| `npm test`（把两个新文件移开后的**基线树**，同机同环境） | **489 tests / 460 pass / 16 fail / 13 skip** —— 逐条同名 |

怎么读这张表（不夸大）：

- 这两个新文件**按构造**就不在这两条命令的作用域里：`tsconfig.json` 的 `include` 是
  `extensions/**`、`src/**`、`tests/**`（无 `.mjs`），`npm test` 的 glob 是 `tests/*.test.ts`。
  所以上面第三行**不构成证明**，只是顺手做的核对；真正的依据是"作用域不相交"。
- `npm run typecheck` 绿**说明不了**这个 `.mjs` 的类型质量——它没被类型检查过，只能被跑（`node --check` 过语法）。
- 那 16 个 fail 是**这台 macOS 上本来就红的**，至少四类：`assertInsideDataDir` 把 `/var/folders/...` 与
  realpath 后的 `/private/var/...` 判成越界（`tests/d-cwd.test.ts:83` 等）、rail/hold 时序断言
  （`tests/i-hold-in-rail.test.ts:166`，实际拿到 `▶ 3 running · 4m 9s`）、watch/blind 路径
  （`blind_exhausted`、`async_kill after watch timeout`）、delayed/pending 取消。仓库 CI 只跑
  `ubuntu-24.04`（见 #81 第 5.2 条）。本报告**不声称 test 全绿**，只声称与本机基线一致。
- 本 worktree 原本没有 `node_modules`（`tsc` 不存在）；上面数字是先 `npm ci --prefer-offline`（119 包，12 s）
  之后跑的。装/不装 `node_modules` 对 `npm test` 的 460/16/13 没有影响。

## 9. 由此得出的下一步（不在本 PR 范围）

- 若接受 B，issue #81 的 1.1 应从"未拆"升格为独立实现 issue：触发条件现在是**已有证据**（本报告），
  不再是"形态学风险"。
- 廉价的过渡项（不需要异步化，但仍需一条小 REV）：把 `(a|a)*` / `(a|aa)+` 一类补进
  `rejectDangerousRegex`。它能挡住本报告 3 个通过形状中的 2 个，挡不住 `(.*a){20}`，**不能替代预算**。
- **不建议**的路线：缩小 `MAX_MATCH_CHARS`。数据说 1 024 就已经被杀、19 码元已过 25 ms，
  要"靠小窗口安全"得缩到 ~16 字符，那会让这个条件失去用途。

## 10. 对抗式复核（两轮，fresh context）

结论与数字都经过独立 read-only 复核（不在本报告作者上下文里跑的 scout），因为"一次静默错误就会把
结论翻成 A"：

| 轮次 | 结果 | 处理 |
|---|---|---|
| 第 1 轮 | 1 blocker + 4 major + 12 minor。blocker = 脚本与报告在复核期间漂移（报告先于它的头条测量定稿）；major = 杀的判定没有独立证据、"child 起不来"会被渲染成 `no match`、§7.4 把"分类会变"说成"只是毫秒变"、"24 码元以内撞线"写错 | 脚本重写（探测/双证据/ERROR 退 1/冷表含 26 码元/6 连调），报告改为"一次 canonical 运行 + 附录 A 逐字"，并把可被机器速度改变的边界格子单列 |
| 第 2 轮 | 6 条旧发现：3 closed / 3 partial（冷 50 ms 门槛写成 19 应为 20；"所有数字来自同一次运行"被两处跨运行引用打破；`--child` 与求值错误仍可能静默）；9 条新缺陷（`--child` 不校验参数、`--json` 在探测失败时无输出、`child runs` 把未 spawn 的槽位算进去、全 BLOCKED 还能绿灯、"把 6× 说成 tier-up"无依据等） | 全部修掉：`--child` 参数校验 + 正则编译失败 `{"error":…}` 退 2、`--json` 探测失败也出对象、槽位/spawn 分开计、加"没测到就退 1"、新增 §4.3 六连调证明 6× 是一次性成本、报告数值全部对齐附录 A |

诚实边界：两轮复核之后**没有**再做第三轮全量复核；第 2 轮列出的缺陷是逐条按证据修的，修复本身只经过
本作者自检（本节的表格就是那两轮的产出清单，便于将来核对）。

<details>
<summary>附录 A：canonical 运行原始 stdout（逐字，§3–§6 的测量值全部来自这里）</summary>

```text
node v22.22.3 (V8 12.4.254.21-node.56) on darwin/arm64 (27.2.0)
cpu: Apple M1 Pro x10; engines floor node 22.19.0; hard kill: 5000 ms (main/ladder), 15000 ms (cold), SIGKILL
subject cap (MAX_MATCH_CHARS): 65536 UTF-16 code units; adversarial tail: "!"

case                regex       size    blacklist  elapsed                                                       
------------------  ----------  ------  ---------  --------------------------------------------------------------
(a|a)*$             (a|a)*$     1024    passes     KILLED >5000 ms (wall 5005 ms, SIGKILL/exit null)             
(a|a)*$             (a|a)*$     8192    passes     KILLED >5000 ms (wall 5004 ms, SIGKILL/exit null)             
(a|a)*$             (a|a)*$     65536   passes     KILLED >5000 ms (wall 5004 ms, SIGKILL/exit null)             
(a+)+$              (a+)+$      1024    BLOCKED    not evaluated (validation rejects it)                         
(a+)+$              (a+)+$      8192    BLOCKED    not evaluated (validation rejects it)                         
(a+)+$              (a+)+$      65536   BLOCKED    not evaluated (validation rejects it)                         
(a|aa)+$            (a|aa)+$    1024    passes     KILLED >5000 ms (wall 5004 ms, SIGKILL/exit null)             
(a|aa)+$            (a|aa)+$    8192    passes     KILLED >5000 ms (wall 5006 ms, SIGKILL/exit null)             
(a|aa)+$            (a|aa)+$    65536   passes     KILLED >5000 ms (wall 5004 ms, SIGKILL/exit null)             
(.*a){20}$          (.*a){20}$  1024    passes     KILLED >5000 ms (wall 5004 ms, SIGKILL/exit null)             
(.*a){20}$          (.*a){20}$  8192    passes     KILLED >5000 ms (wall 5004 ms, SIGKILL/exit null)             
(.*a){20}$          (.*a){20}$  65536   passes     KILLED >5000 ms (wall 5005 ms, SIGKILL/exit null)             
^(a|a)*$            ^(a|a)*$    1024    passes     KILLED >5000 ms (wall 5004 ms, SIGKILL/exit null)             
^(a|a)*$            ^(a|a)*$    8192    passes     KILLED >5000 ms (wall 5003 ms, SIGKILL/exit null)             
^(a|a)*$            ^(a|a)*$    65536   passes     KILLED >5000 ms (wall 5004 ms, SIGKILL/exit null)             
(a|a)*$ no-tail     (a|a)*$     1024    passes     0.03 ms match                                                 
(a|a)*$ no-tail     (a|a)*$     8192    passes     0.05 ms match                                                 
(a|a)*$ no-tail     (a|a)*$     65536   passes     0.24 ms match                                                 
ready|done control  ready|done  1024    passes     0.02 ms no match                                              
ready|done control  ready|done  8192    passes     0.03 ms no match                                              
ready|done control  ready|done  65536   passes     0.06 ms no match                                              

smallest hangable input per shape: subject = "a" * (n-1) + "!"
regex       n       elapsed                                                       
(a|a)*$     10      0.04 ms match                                                 
(a|a)*$     12      0.07 ms match                                                 
(a|a)*$     14      0.23 ms match                                                 
(a|a)*$     16      0.84 ms match                                                 
(a|a)*$     18      3.21 ms match                                                 
(a|a)*$     20      12.9 ms match                                                 
(a|a)*$     22      47.7 ms match                                                 
(a|a)*$     24      192.9 ms match                                                
(a|a)*$     26      780.1 ms match                                                
(a|a)*$     28      3.10 s match                                                  
(a|a)*$     30      KILLED >5000 ms (wall 5006 ms, SIGKILL/exit null)             
(a|aa)+$    20      0.30 ms no match                                              
(a|aa)+$    24      1.86 ms no match                                              
(a|aa)+$    28      11.9 ms no match                                              
(a|aa)+$    32      81.7 ms no match                                              
(a|aa)+$    40      3.87 s no match                                               
(a|aa)+$    48      KILLED >5000 ms (wall 5003 ms, SIGKILL/exit null)             
(a|aa)+$    64      KILLED >5000 ms (wall 5003 ms, SIGKILL/exit null)             
(.*a){20}$  16      0.91 ms no match                                              
(.*a){20}$  20      14.3 ms no match                                              
(.*a){20}$  22      54.7 ms no match                                              
(.*a){20}$  24      219.8 ms no match                                             
(.*a){20}$  26      882.3 ms no match                                             
(.*a){20}$  28      3.53 s no match                                               
(.*a){20}$  32      KILLED >5000 ms (wall 5003 ms, SIGKILL/exit null)             

cold vs warm: FIRST call on a freshly compiled regexp vs a warmed call; cold budget 15000 ms
regex       n       cold                                                            warm            ratio 
(a|a)*$     18      19.7 ms match                                                   3.29 ms         6.0x  
(a|a)*$     19      39.0 ms match                                                   6.58 ms         5.9x  
(a|a)*$     20      78.2 ms match                                                   12.1 ms         6.5x  
(a|a)*$     21      160.6 ms match                                                  24.7 ms         6.5x  
(a|a)*$     22      315.2 ms match                                                  47.7 ms         6.6x  
(a|a)*$     24      1.28 s match                                                    192.4 ms        6.6x  
(a|a)*$     26      5.02 s match                                                    781.4 ms        6.4x  
(.*a){20}$  20      45.9 ms no match                                                14.0 ms         3.3x  
(a|aa)+$    28      94.3 ms no match                                                12.1 ms         7.8x  
ready|done  65536   0.14 ms no match                                                0.06 ms         2.4x  
(a|a)*$     65536   0.33 ms match                                                   0.24 ms         1.4x  

first-call vs subsequent calls: regex "(a|a)*$", 18 code units, 6 consecutive calls on ONE RegExp object
  #1 19.4 ms  #2 3.31 ms  #3 3.28 ms  #4 3.18 ms  #5 3.27 ms  #6 3.19 ms

event-loop stall demo: regex "(a|a)*$", subject "a"*27 + "!" (28 code units), 100 ms timer armed first
  eval returned after      : 3.12 s (matched=true)
  the 100 ms timer fired at: 3.12 s after the arm
  verdict                  : STALLED — nothing else in the process ran during the evaluation

measurement slots: 70; children spawned: 67; ok: 51; killed by timeout: 16; errors: 0; validation-blocked slots (never spawned): 3
slowest measured evaluation: 5.02 s (26 code units, matched=true)
```

</details>
